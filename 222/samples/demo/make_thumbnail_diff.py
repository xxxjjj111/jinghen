# -*- coding: utf-8 -*-
"""
生成「缩略图不一致」演示样本（⑤）：
- 主图：已脱敏（敏感区域涂黑/马赛克）的图
- 内嵌缩略图：还是未脱敏的"原图"（能看到敏感文字）
用户在外发前用本工具检测 → 提示"缩略图与主图不一致，缩略图可能泄露原始内容"
无 exiftool，手动构造 JPEG EXIF APP1 段注入缩略图。
"""
import struct
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

# ---------- 1. 敏感"原图"（用来做缩略图内容） ----------
def draw_scene(text, redact_boxes=()):
    img = Image.new("RGB", (800, 500), (245, 247, 250))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
    except Exception:
        font = small = ImageFont.load_default()
    # 标题
    d.rectangle([0, 0, 800, 70], fill=(30, 60, 120))
    d.text((30, 18), "客户报价单(内部)", font=font, fill=(255, 255, 255))
    # 内容行
    y = 120
    for line in text:
        d.text((40, y), line, font=small, fill=(30, 30, 30))
        y += 45
    # 涂黑敏感区（脱敏标记）
    for (x0, y0, x1, y1) in redact_boxes:
        d.rectangle([x0, y0, x1, y1], fill=(0, 0, 0))
        d.text((x0 + 8, y0 + 6), "■脱敏", font=small, fill=(255, 255, 255))
    return img

# 未脱敏原图（含敏感数字）→ 做缩略图
sensitive_lines = [
    "客户：杭州XX科技有限公司",
    "合同金额：1,200,000 元",
    "回扣比例：30%（内部）",
    "折扣底价：￥860,000",
    "联系人：张教授 138****0000",
]
original = draw_scene(sensitive_lines)
# 缩略图 = 未脱敏原图缩小
thumb_img = original.resize((160, 100), Image.LANCZOS)
thumb_buf = BytesIO()
thumb_img.save(thumb_buf, "JPEG", quality=80)
thumb_bytes = thumb_buf.getvalue()

# ---------- 2. 主图 = 已脱敏（敏感数字区域涂黑） ----------
sanitized = draw_scene(
    [
        "客户：杭州XX科技有限公司",
        "合同金额：■■■■■■■■",
        "回扣比例：■■■（内部）",
        "折扣底价：￥■■■■■■",
        "联系人：张教授 138****0000",
    ],
    redact_boxes=[(150, 115, 560, 155), (150, 160, 480, 200), (150, 205, 470, 245)],
)
main_buf = BytesIO()
sanitized.save(main_buf, "JPEG", quality=85)
main_jpeg = main_buf.getvalue()

# ---------- 3. 构造 EXIF APP1 段（内嵌缩略图） ----------
def build_exif_with_thumbnail(thumb):
    # TIFF 头（小端）
    make_b = b"PIL\0"
    model_b = b"CamDemo\0"
    # 布局：
    # tiff头(8) | IFD0(count+3*12+next) | IFD1(count+4*12+next) | Make | Model | thumb
    # IFD0：Make/Model/Orientation；IFD1：宽高 + 缩略图指针(0x0201/0x0202)
    ifd0_off = 8
    ifd1_off = ifd0_off + 2 + 3 * 12 + 4
    str_off = ifd1_off + 2 + 4 * 12 + 4
    make_off = str_off
    model_off = str_off + len(make_b)
    thumb_off = model_off + len(model_b)
    thumb_off = (thumb_off + 1) & ~1

    out = bytearray()
    out += b"II" + struct.pack("<H", 0x002A) + struct.pack("<I", ifd0_off)
    # IFD0：Make, Model, Orientation
    out += struct.pack("<H", 3)
    out += struct.pack("<HHII", 0x010F, 2, len(make_b), make_off)
    out += struct.pack("<HHII", 0x0110, 2, len(model_b), model_off)
    out += struct.pack("<HHII", 0x0112, 3, 1, 1)
    out += struct.pack("<I", ifd1_off)  # next IFD
    assert len(out) == ifd1_off, f"ifd0 layout {len(out)}!={ifd1_off}"
    # IFD1：宽/高 + 缩略图指针
    out += struct.pack("<H", 4)
    out += struct.pack("<HHII", 0x0100, 3, 1, 160)   # ImageWidth
    out += struct.pack("<HHII", 0x0101, 3, 1, 100)   # ImageLength
    out += struct.pack("<HHII", 0x0201, 4, 1, thumb_off)  # JPEGInterchangeFormat
    out += struct.pack("<HHII", 0x0202, 4, 1, len(thumb))  # JPEGInterchangeFormatLength
    out += struct.pack("<I", 0)  # next
    assert len(out) == str_off, f"ifd1 layout {len(out)}!={str_off}"
    out += make_b
    out += model_b
    assert len(out) == thumb_off, f"str layout {len(out)}!={thumb_off}"
    out += thumb
    return b"Exif\x00\x00" + bytes(out)  # APP1 段负载必须带 Exif 前缀

exif_app1 = build_exif_with_thumbnail(thumb_bytes)

# ---------- 4. 拼完整 JPEG：SOI + 我的EXIF APP1 + 主图其余段 ----------
# 注意：绝不能删 DQT/SOF/DHT（量化/哈夫曼表），否则主图无法解码。
# 只去掉主图自己的 SOI(2字节) 和开头的 APP0(JFIF) 段，其余（DQT/SOF/DHT/SOS/扫描数据）全保留。
def skip_soi_and_app0(jpeg):
    i = 2  # 跳过 FFD8
    if i < len(jpeg) and jpeg[i] == 0xFF and jpeg[i + 1] == 0xE0:
        ln = struct.unpack(">H", jpeg[i + 2:i + 4])[0]
        i += 2 + ln
    return jpeg[i:]  # 从第一个 DQT(FFDB) 起

main_body = skip_soi_and_app0(main_jpeg)
final = b"\xFF\xD8" + b"\xFF\xE1" + struct.pack(">H", len(exif_app1) + 2) + exif_app1 + main_body

out_path = "/home/user/Doubao/chats/38447830452557314/_wang2/网安第二版/samples/demo/演示5_缩略图不一致.jpg"
with open(out_path, "wb") as f:
    f.write(final)
print("写入", out_path, len(final), "bytes")
