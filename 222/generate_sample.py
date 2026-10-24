"""
生成测试样本：带修订记录和批注的 DOCX 文件
直接手动构造 DOCX 的 XML 内容，保证修订记录存在。
"""
import zipfile
import os
from datetime import datetime

# 样本输出路径
output_path = os.path.join(os.path.dirname(__file__), "samples", "有修订的论文.docx")
os.makedirs(os.path.dirname(output_path), exist_ok=True)

# ============================================================
# 构造各 XML 文件内容
# ============================================================

# [Content_Types].xml —— 内容类型清单
content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''

# _rels/.rels —— 顶层关系
rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
    <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''

# word/_rels/document.xml.rels —— 文档关系（包含批注引用）
doc_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>'''

# docProps/core.xml —— 核心元数据（含作者等敏感信息）
now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
core_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:dcterms="http://purl.org/dc/terms/"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <dc:title>基于深度学习的图像识别研究</dc:title>
    <dc:subject>计算机视觉</dc:subject>
    <dc:creator>张教授</dc:creator>
    <cp:lastModifiedBy>李同学</cp:lastModifiedBy>
    <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
    <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>'''

# docProps/app.xml —— 应用属性
app_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
    xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
    <Application>Microsoft Office Word</Application>
</Properties>'''

# word/document.xml —— 文档主体（含修订记录）
# 内容模拟一篇论文，导师名字被"删掉"了，但还在修订记录里
document_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
        <!-- 标题 -->
        <w:p>
            <w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="32"/><w:b/></w:rPr></w:pPr>
            <w:r><w:rPr><w:sz w:val="32"/><w:b/></w:rPr><w:t>基于深度学习的图像识别研究</w:t></w:r>
        </w:p>

        <!-- 作者行：导师名字被"删除"了，但还在 <w:del> 里 -->
        <w:p>
            <w:pPr><w:jc w:val="center"/></w:pPr>
            <w:r><w:t>作者：王小明</w:t></w:r>
            <!-- 删除的内容：导师姓名（二次泄露！） -->
            <w:del w:id="1" w:author="张教授" w:date="2024-03-15T10:30:00Z">
                <w:r><w:delText xml:space="preserve">  指导教师：张教授</w:delText></w:r>
            </w:del>
        </w:p>

        <!-- 摘要段落 -->
        <w:p>
            <w:pPr><w:spacing w:before="200"/></w:pPr>
            <w:r><w:rPr><w:b/></w:rPr><w:t>摘要：</w:t></w:r>
            <!-- 插入的内容 -->
            <w:ins w:id="2" w:author="李同学" w:date="2024-03-16T14:20:00Z">
                <w:r><w:t>本文提出了一种基于卷积神经网络的图像识别方法，</w:t></w:r>
            </w:ins>
            <w:r><w:t>在公开数据集上取得了较好的效果。</w:t></w:r>
            <!-- 删除的旧内容 -->
            <w:del w:id="3" w:author="李同学" w:date="2024-03-16T14:20:00Z">
                <w:r><w:delText>本文研究了传统机器学习方法在图像识别中的应用。</w:delText></w:r>
            </w:del>
        </w:p>

        <!-- 关键词 -->
        <w:p>
            <w:r><w:rPr><w:b/></w:rPr><w:t>关键词：</w:t></w:r>
            <w:r><w:t>深度学习；图像识别；卷积神经网络</w:t></w:r>
        </w:p>

        <!-- 带批注引用的段落 -->
        <w:p>
            <w:pPr><w:spacing w:before="200"/></w:pPr>
            <w:r><w:rPr><w:b/></w:rPr><w:t>1. 引言</w:t></w:r>
        </w:p>
        <w:p>
            <!-- 批注开始 -->
            <w:commentRangeStart w:id="100"/>
            <w:r><w:t>图像识别是计算机视觉领域的重要研究方向，</w:t></w:r>
            <w:r><w:t>近年来随着深度学习的发展取得了显著进展。</w:t></w:r>
            <!-- 批注结束 -->
            <w:commentRangeEnd w:id="100"/>
            <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="100"/></w:r>
        </w:p>

        <w:p>
            <w:r><w:t>本文主要研究卷积神经网络在图像分类任务中的应用。</w:t></w:r>
        </w:p>

        <!-- 节属性 -->
        <w:sectPr>
            <w:pgSz w:w="11906" w:h="16838"/>
            <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>
        </w:sectPr>
    </w:body>
</w:document>'''

# word/comments.xml —— 批注内容
comments_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:comment w:id="100" w:author="张教授" w:date="2024-03-17T09:15:00Z" w:initials="张">
        <w:p>
            <w:r><w:t>这一段写得不够深入，需要补充相关工作的对比。</w:t></w:r>
        </w:p>
    </w:comment>
</w:comments>'''

# ============================================================
# 打包成 DOCX
# ============================================================

with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("[Content_Types].xml", content_types)
    zf.writestr("_rels/.rels", rels)
    zf.writestr("word/_rels/document.xml.rels", doc_rels)
    zf.writestr("docProps/core.xml", core_xml)
    zf.writestr("docProps/app.xml", app_xml)
    zf.writestr("word/document.xml", document_xml)
    zf.writestr("word/comments.xml", comments_xml)

print(f"✅ 测试样本已生成：{output_path}")
print(f"   文件大小：{os.path.getsize(output_path)} 字节")
print()
print("   包含的检测项：")
print("   ✅ 元数据泄露（作者：张教授，修改者：李同学）")
print("   ✅ 修订记录-删除（指导教师：张教授 被删除但仍可恢复）")
print("   ✅ 修订记录-插入（摘要中新增的句子）")
print("   ✅ 批注残留（张教授的批注）")
