# -*- coding: utf-8 -*-
"""生成带 GPS 的演示样本（表3 第④项）：一张含经纬度 EXIF 的 JPEG，工具应检出坐标"""
import struct
from io import BytesIO
from PIL import Image, ImageDraw

# ---------- 1. 普通图片 ----------
img = Image.new("RGB", (900, 600), (200, 220, 240))
d = ImageDraw.Draw(img)
try:
    from PIL import ImageFont
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 36)
except Exception:
    font = ImageFont.load_default()
d.rectangle([0, 0, 900, 80], fill=(40, 70, 130))
d.text((30, 25), "西湖边拍摄的照片(示例)", font=font, fill=(255, 255, 255))
main_buf = BytesIO()
img.save(main_buf, "JPEG", quality=90)
main_jpeg = main_buf.getvalue()

# ---------- 2. 构造含 GPS 的 EXIF APP1 ----------
def rational(num, den=1):
    return struct.pack("<II", num, den)

# GPS 坐标：30°15'0"N, 120°9'0"E  (≈30.25, 120.15)
lat_rat = rational(30) + rational(15) + rational(0)   # 24 字节
lng_rat = rational(120) + rational(9) + rational(0)   # 24 字节
make_b = b"CamX\0"
model_b = b"PhoneGpsPro\0"
latref_b = b"N\0"
lngref_b = b"E\0"

# 布局（相对 TIFF 起点）
# tiff头(8) | IFD0(count+4*12+next=54) | GPSIFD(count+4*12+next=54) | 数据区
ifd0_off = 8
gps_ifd_off = ifd0_off + 2 + 4 * 12 + 4          # = 62
data_off = gps_ifd_off + 2 + 4 * 12 + 4          # = 116
make_off = data_off
model_off = make_off + len(make_b)
latref_off = model_off + len(model_b)
lngref_off = latref_off + len(latref_b)
latval_off = lngref_off + len(lngref_b)
lngval_off = latval_off + len(lat_rat)

out = bytearray()
out += b"II" + struct.pack("<H", 0x002A) + struct.pack("<I", ifd0_off)
# IFD0：Make, Model, Orientation, GPSInfo
out += struct.pack("<H", 4)
out += struct.pack("<HHII", 0x010F, 2, len(make_b), make_off)
out += struct.pack("<HHII", 0x0110, 2, len(model_b), model_off)
out += struct.pack("<HHII", 0x0112, 3, 1, 1)
out += struct.pack("<HHII", 0x8825, 4, 1, gps_ifd_off)
out += struct.pack("<I", 0)  # next IFD
assert len(out) == gps_ifd_off, len(out)
# GPS IFD：LatRef, Lat, LngRef, Lng
out += struct.pack("<H", 4)
out += struct.pack("<HHII", 0x0001, 2, len(latref_b), latref_off)
out += struct.pack("<HHII", 0x0002, 5, 3, latval_off)
out += struct.pack("<HHII", 0x0003, 2, len(lngref_b), lngref_off)
out += struct.pack("<HHII", 0x0004, 5, 3, lngval_off)
out += struct.pack("<I", 0)  # next
assert len(out) == data_off, len(out)
# 数据区
out += make_b
out += model_b
out += latref_b
out += lngref_b
out += lat_rat
out += lng_rat

exif_app1 = b"Exif\x00\x00" + bytes(out)

# ---------- 3. 拼接：SOI + EXIF APP1 + 主图(去SOI和APP0) ----------
def skip_soi_and_app0(jpeg):
    i = 2
    if i < len(jpeg) and jpeg[i] == 0xFF and jpeg[i + 1] == 0xE0:
        ln = struct.unpack(">H", jpeg[i + 2:i + 4])[0]
        i += 2 + ln
    return jpeg[i:]

final = b"\xFF\xD8" + b"\xFF\xE1" + struct.pack(">H", len(exif_app1) + 2) + exif_app1 + skip_soi_and_app0(main_jpeg)
out_path = "/home/user/Doubao/chats/38447830452557314/_wang2/网安第二版/samples/demo/演示GPS_西湖坐标.jpg"
with open(out_path, "wb") as f:
    f.write(final)
print("写入", out_path, len(final), "bytes")
