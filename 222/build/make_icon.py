# -*- coding: utf-8 -*-
"""生成「残影体检台」应用图标 build/icon.png (256x256)
主题：深色赛博朋克 + 盾牌 + 放大镜（外发前自查/体检）
配色：底 #0d1117，霓虹蓝 #00d4ff，警示红 #ff3b30
"""
from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形底（深色 + 霓虹蓝描边）
d.rounded_rectangle([6, 6, S - 6, S - 6], radius=52, fill=(13, 17, 23, 255), outline=(0, 212, 255, 255), width=5)

# 盾牌
shield = [(128, 38), (204, 72), (204, 148), (128, 216), (52, 148), (52, 72)]
d.polygon(shield, fill=(0, 212, 255, 34), outline=(0, 212, 255, 255))
# 盾牌内扫描线（体检感）
for yy in (92, 112, 132):
    d.line([(84, yy), (172, yy)], fill=(0, 212, 255, 90), width=3)

# 放大镜（居中）
cx, cy, r = 118, 118, 36
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(230, 247, 255, 255), width=9)
d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=(0, 212, 255, 120))
d.line([(cx + 26, cy + 26), (176, 176)], fill=(230, 247, 255, 255), width=14)

# 右上警示红点
d.ellipse([202, 30, 228, 56], fill=(255, 59, 48, 255))

# 顶部细高光
d.rounded_rectangle([24, 12, S - 24, 16], radius=2, fill=(255, 255, 255, 40))

out = "/home/user/Doubao/chats/38447830452557314/_wang2/网安第二版/build/icon.png"
img.save(out)
print("写入", out, img.size, img.mode)
