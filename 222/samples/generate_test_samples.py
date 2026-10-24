# -*- coding: utf-8 -*-
"""
生成用于测试"残影"工具的样本文件
运行后会在当前目录生成：
  - test_photo_gps.jpg     带 EXIF + GPS 信息的照片
  - test_pdf_fake_cover.pdf  带假黑框遮挡的 PDF（文字层还在）
"""

import os  # 操作系统接口，用于路径拼接
from PIL import Image, ImageDraw, ImageFont  # Pillow 库：创建和编辑图片
import piexif  # piexif 库：操作 JPEG 的 EXIF 元数据
from reportlab.lib.pagesizes import A4  # reportlab：生成 PDF，A4 纸张尺寸
from reportlab.pdfgen import canvas  # reportlab：PDF 画布对象

# ---------- 第一步：生成带 EXIF + GPS 的测试照片 ----------

def create_test_photo(output_path):
    """
    创建一张带 EXIF 元数据和 GPS 定位信息的 JPEG 测试照片
    参数：output_path - 输出文件路径（字符串）
    返回：无，直接生成文件
    """
    # 1. 创建一张 800x600 的纯色图片，模拟一张照片
    # Image.new(mode, size, color) — 创建新图片，RGB模式，800宽600高，浅蓝色背景
    img = Image.new("RGB", (800, 600), (135, 206, 235))

    # 2. 在图片上画一些文字，说明这是测试照片
    draw = ImageDraw.Draw(img)  # 创建绘图对象，用于在图片上画东西
    # text(位置, 文字, 填充颜色) — 在图片上写字
    draw.text((50, 50), "测试照片 - 含 EXIF + GPS", fill=(0, 0, 0))
    draw.text((50, 80), "地点：杭州西湖", fill=(0, 0, 0))
    draw.text((50, 110), "相机：Canon EOS 5D Mark IV", fill=(0, 0, 0))

    # 3. 构造 EXIF 数据（字典结构，分 0th/Exif/GPS 等几个段）
    # 0th 段：主要信息（相机型号、制造商、方向等）
    zeroth_ifd = {
        piexif.ImageIFD.Make: u"Canon",              # 相机制造商
        piexif.ImageIFD.Model: u"Canon EOS 5D Mark IV",  # 相机型号
        piexif.ImageIFD.Software: u"Adobe Photoshop CC", # 处理软件
        piexif.ImageIFD.DateTime: u"2024:05:20 14:30:00",  # 拍摄时间
        piexif.ImageIFD.Artist: u"Zhang San",        # 作者（摄影师姓名）
        piexif.ImageIFD.ImageDescription: u"Hangzhou West Lake trip",  # 图片描述
    }

    # Exif 段：详细拍摄参数
    exif_ifd = {
        piexif.ExifIFD.DateTimeOriginal: u"2024:05:20 14:30:00",  # 原始拍摄时间
        piexif.ExifIFD.DateTimeDigitized: u"2024:05:20 14:30:00",  # 数字化时间
        piexif.ExifIFD.ExposureTime: (1, 200),       # 曝光时间 1/200 秒
        piexif.ExifIFD.FNumber: (56, 10),            # 光圈 f/5.6
        piexif.ExifIFD.ISOSpeedRatings: 100,         # ISO 感光度
        piexif.ExifIFD.FocalLength: (500, 10),       # 焦距 50mm
        piexif.ExifIFD.LensModel: u"EF 50mm f/1.8 STM",  # 镜头型号
        piexif.ExifIFD.UserComment: "PRIVATE: This photo contains sensitive location data".encode("utf-8"),  # 用户备注
    }

    # GPS 段：GPS 定位信息（杭州西湖坐标：北纬30.25°，东经120.13°）
    # EXIF 里 GPS 用度分秒格式存储，比如 30°15'00"N = (30,1),(15,1),(0,1)
    gps_ifd = {
        piexif.GPSIFD.GPSVersionID: (2, 0, 0, 0),  # GPS 版本 2.0
        piexif.GPSIFD.GPSLatitudeRef: "N",          # 北纬
        piexif.GPSIFD.GPSLatitude: ((30, 1), (15, 1), (0, 1)),  # 30°15'00"
        piexif.GPSIFD.GPSLongitudeRef: "E",         # 东经
        piexif.GPSIFD.GPSLongitude: ((120, 1), (7, 1), (48, 1)),  # 120°7'48"
        piexif.GPSIFD.GPSAltitudeRef: 0,            # 海拔（0=海平面以上）
        piexif.GPSIFD.GPSAltitude: (15, 1),         # 海拔 15 米
        piexif.GPSIFD.GPSDateStamp: u"2024:05:20",  # GPS 日期
    }

    # 4. 把三段 EXIF 组装成完整的 EXIF 字典
    exif_dict = {"0th": zeroth_ifd, "Exif": exif_ifd, "GPS": gps_ifd, "1st": {}, "thumbnail": None}

    # 5. 将 EXIF 字典转换成二进制数据
    # dumps() — 把字典序列化成 JPEG 能识别的 EXIF 字节串
    exif_bytes = piexif.dump(exif_dict)

    # 6. 保存图片，同时写入 EXIF 数据
    # save(路径, 格式, exif=...) — 保存为 JPEG，并附带 EXIF 元数据
    img.save(output_path, "jpeg", exif=exif_bytes)
    print(f"✅ 已生成带 EXIF+GPS 的测试照片：{output_path}")


# ---------- 第二步：生成带假黑框遮挡的测试 PDF ----------

def create_fake_cover_pdf(output_path):
    """
    创建一个带"假黑框遮挡"的 PDF 文件
    原理：先写文字，再用黑色矩形盖在上面，但文字层仍然存在，复制粘贴就能读出来
    参数：output_path - 输出文件路径（字符串）
    返回：无，直接生成文件
    """
    # 1. 创建 PDF 画布对象
    # canvas.Canvas(路径, pagesize=...) — 创建 PDF 画布，指定输出路径和纸张大小
    c = canvas.Canvas(output_path, pagesize=A4)

    # A4 纸宽度（从 reportlab 获取）
    page_width, page_height = A4

    # 2. 写标题
    c.setFont("Helvetica-Bold", 20)  # 设置字体：Helvetica 粗体，20号
    c.drawString(50, page_height - 60, "Confidential Document")  # 在指定坐标写字

    # 3. 写正文段落（包含"敏感信息"）
    c.setFont("Helvetica", 12)  # 正文字体：12号
    text_lines = [
        "To: CEO Office",
        "From: Finance Department",
        "Date: 2024-06-15",
        "",
        "Subject: Q2 Revenue Report - Internal Use Only",
        "",
        "The total revenue for Q2 2024 is 12,580,000 RMB.",
        "This represents a 23% increase compared to Q1.",
        "",
        "Sensitive data below:",
        "",
        "Employee salary data for reference:",
        "  - Zhang Wei (CEO): 250,000 RMB/month",
        "  - Li Ming (CTO): 180,000 RMB/month",
        "  - Wang Fang (CFO): 165,000 RMB/month",
        "  - Zhao Qiang (VP Sales): 150,000 RMB/month",
        "",
        "Client contact list (top 5):",
        "  1. Alibaba Group - Mr. Chen: 13800138001",
        "  2. Tencent Holdings - Ms. Liu: 13900139002",
        "  3. ByteDance - Mr. Wang: 13700137003",
        "  4. Huawei Tech - Ms. Zhang: 13600136004",
        "  5. Xiaomi Corp - Mr. Li: 13500135005",
        "",
        "Bank account details:",
        "  Account Name: XX Technology Co., Ltd.",
        "  Account Number: 6222 0212 3456 7890 123",
        "  Bank: ICBC Hangzhou Branch",
    ]

    # 4. 逐行写入 PDF
    y = page_height - 100  # 起始 Y 坐标（从顶部往下 100 点）
    for line in text_lines:
        c.drawString(50, y, line)  # drawString(x, y, 文字) — 在坐标位置写字
        y -= 20  # 每写完一行，Y 坐标减 20（往下移一行）

    # 5. 画黑色矩形"假遮挡"——盖在敏感内容上面
    # 注意：这些黑框只是视觉遮挡，文字层仍然在 PDF 里
    # setFillColorRGB(r,g,b) — 设置填充颜色，(0,0,0) 是黑色
    c.setFillColorRGB(0, 0, 0)

    # 遮挡工资信息（第 13-16 行左右）
    # rect(x, y, 宽, 高, 填充, 描边) — 画矩形，fill=1 表示填充
    c.rect(50, page_height - 340, 450, 80, fill=1, stroke=0)

    # 遮挡客户联系方式
    c.rect(50, page_height - 480, 450, 100, fill=1, stroke=0)

    # 遮挡银行账户信息
    c.rect(50, page_height - 600, 450, 60, fill=1, stroke=0)

    # 6. 添加一段说明文字（在遮挡区域上方）
    c.setFillColorRGB(1, 1, 1)  # 白色文字
    c.setFont("Helvetica-Bold", 10)
    c.drawString(60, page_height - 295, "[ REDACTED - Sensitive Information ]")
    c.drawString(60, page_height - 435, "[ REDACTED - Client Confidential ]")
    c.drawString(60, page_height - 555, "[ REDACTED - Financial Data ]")

    # 7. 设置 PDF 元数据（顺便测试 PDF 元数据检测功能）
    c.setTitle("Q2 Revenue Report - Confidential")  # 标题
    c.setAuthor("Finance Department - Wang Fang")    # 作者
    c.setSubject("Internal financial report")        # 主题
    c.setKeywords(["revenue", "salary", "confidential", "Q2 2024"])  # 关键词
    c.setCreator("Report Generator v2.1")            # 创建工具

    # 8. 保存 PDF
    c.save()
    print(f"✅ 已生成带假黑框遮挡的测试 PDF：{output_path}")
    print("   （提示：黑框下面的文字仍然存在，可以复制粘贴读出来）")


# ---------- 主程序：生成所有测试样本 ----------

if __name__ == "__main__":
    # 获取当前脚本所在目录，输出文件就放在这个目录里
    # os.path.dirname(os.path.abspath(__file__)) — 得到当前 .py 文件所在的文件夹路径
    output_dir = os.path.dirname(os.path.abspath(__file__))

    # 生成带 EXIF+GPS 的照片
    photo_path = os.path.join(output_dir, "test_photo_gps.jpg")
    create_test_photo(photo_path)

    # 生成带假黑框的 PDF
    pdf_path = os.path.join(output_dir, "test_pdf_fake_cover.pdf")
    create_fake_cover_pdf(pdf_path)

    print("\n🎉 所有测试样本生成完毕！拖进残影工具里试试吧。")
