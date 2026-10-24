/**
 * risk-score.js — 风险评分模块
 *
 * 根据各检测项的结果，计算一个综合的风险分数（0-100），
 * 并划分风险等级：绿色（安全）/ 黄色（中等风险）/ 红色（高风险）。
 *
 * 评分规则采用加权计分法，同时有"高危项一票变红"的规则
 * （只要命中任何一个高危项，直接判高风险）。
 */

/**
 * 权重配置表 —— 每个检测项的分值
 * （可以根据需要调整，这里是初始值）
 */
const RISK_WEIGHTS = {
    // DOCX 相关
    docx_revisions_deletion: 25,   // 有删除的修订记录（最敏感，删了什么还能看到）
    docx_revisions_insertion: 10,  // 有插入的修订记录
    docx_comments: 20,             // 有批注
    docx_metadata: 15,             // 有元数据（作者等）
    docx_hidden_text: 35,          // 隐藏文字（同色背景 / vanish / 极小字号，高危）

    // xlsx 相关
    xlsx_hidden_text: 35,          // 白字/同色文字（高危）
    xlsx_hidden_rowcol: 15,        // 隐藏行/列
    xlsx_hidden_sheet: 20,         // 隐藏工作表
    xlsx_comments: 20,             // 单元格批注
    xlsx_metadata: 15,             // 元数据（作者等）

    // pptx 相关
    pptx_notes: 40,                // 演讲者备注页（观众看不到但文件里有，高危）
    pptx_comments: 20,             // 批注
    pptx_hidden_slide: 25,         // 隐藏幻灯片
    pptx_metadata: 15,             // 元数据（作者等）

    // doc(旧版 Word) 相关
    doc_metadata: 25,              // 元数据（作者/最后保存者等）

    // 图片相关
    image_gps: 30,                 // 有 GPS 位置信息（高危）
    image_exif_sensitive: 15,      // 有敏感 EXIF 信息
    image_thumbnail_diff: 40,      // 缩略图与主图不一致（高危）
    image_pii_id_card: 35,         // 图片中有身份证号（高危）
    image_pii_phone: 25,           // 图片中有手机号
    image_pii_name: 15,            // 图片中有姓名
    image_pii_address: 25,         // 图片中有地址

    // PDF 相关
    pdf_incremental: 20,           // 有增量保存版本
    pdf_fake_redaction: 40,        // 假黑框（文字被矩形覆盖但还能复制，高危）
    pdf_metadata: 15,              // 有元数据
    pdf_annotations: 20,           // 有批注/注释（类似 Word 批注）
};

/**
 * 高危项列表 —— 命中任何一个直接判红（高风险）
 * 这些是"看起来删了但其实还在"的典型二次泄露
 */
const HIGH_RISK_KEYS = [
    "docx_revisions_deletion",   // 修订里有被删除的文字
    "docx_hidden_text",          // DOCX 隐藏文字（同色/vanish/极小字号）
    "xlsx_hidden_text",          // Excel 白字/同色隐藏文字
    "pptx_notes",                // PPT 演讲者备注页
    "image_gps",                 // 照片有 GPS 位置
    "image_thumbnail_diff",      // 缩略图是原图
    "image_pii_id_card",         // 照片中有身份证号
    "pdf_fake_redaction",        // 假黑框遮挡
];

/**
 * 根据检测结果计算风险评分
 * @param {Object} analysisResult - 分析结果（包含 docx/image/pdf 等的检测结果）
 * @returns {{ score: number, level: string, details: Object, reasons: string[] }}
 *   - score: 分数（0-100）
 *   - level: "safe"（绿）/ "medium"（黄）/ "high"（红）
 *   - details: 每个检测项的得分详情
 *   - reasons: 风险原因列表（用于展示给用户看）
 *
 * 使用方式：
 *   const risk = calculateRisk(result);
 *   console.log(risk.score, risk.level);  // 75, "high"
 */
function calculateRisk(analysisResult) {
    // 每个检测项的得分明细（方便调试和展示）
    const details = {};
    // 风险原因列表（用人类可读的话描述）
    const reasons = [];
    // 是否命中高危项（命中则直接判红）
    let hasHighRisk = false;
    // 总分
    let totalScore = 0;

    // ============================================================
    // 1. DOCX 检测项
    // ============================================================
    if (analysisResult.docx && !analysisResult.docx.error) {
        const docx = analysisResult.docx;

        // 修订记录中的删除项（高危）
        if (docx.revisions && docx.revisions.deletions && docx.revisions.deletions.length > 0) {
            details.docx_revisions_deletion = RISK_WEIGHTS.docx_revisions_deletion;
            totalScore += RISK_WEIGHTS.docx_revisions_deletion;
            reasons.push(`文档中残留 ${docx.revisions.deletions.length} 处删除修订记录，被删除的文字仍可恢复`);
        }

        // 修订记录中的插入项
        if (docx.revisions && docx.revisions.insertions && docx.revisions.insertions.length > 0) {
            details.docx_revisions_insertion = RISK_WEIGHTS.docx_revisions_insertion;
            totalScore += RISK_WEIGHTS.docx_revisions_insertion;
            reasons.push(`文档中残留 ${docx.revisions.insertions.length} 处插入修订记录`);
        }

        // 批注
        if (docx.comments && docx.comments.hasComments) {
            details.docx_comments = RISK_WEIGHTS.docx_comments;
            totalScore += RISK_WEIGHTS.docx_comments;
            reasons.push(`文档中残留 ${docx.comments.count} 条批注，包含作者信息`);
        }

        // 元数据
        if (docx.metadata && docx.metadata.hasSensitive) {
            details.docx_metadata = RISK_WEIGHTS.docx_metadata;
            totalScore += RISK_WEIGHTS.docx_metadata;
            reasons.push(`文档元数据包含作者信息：${docx.metadata.author || "未知"}`);
        }

        // 隐藏文字（高危）
        if (docx.hiddenText && docx.hiddenText.hasHiddenText) {
            details.docx_hidden_text = RISK_WEIGHTS.docx_hidden_text;
            totalScore += RISK_WEIGHTS.docx_hidden_text;
            const parts = [];
            if (docx.hiddenText.sameColorCount > 0) parts.push(`同色背景 ${docx.hiddenText.sameColorCount} 处`);
            if (docx.hiddenText.vanishCount > 0) parts.push(`隐藏格式 ${docx.hiddenText.vanishCount} 处`);
            if (docx.hiddenText.tinyFontCount > 0) parts.push(`极小字号 ${docx.hiddenText.tinyFontCount} 处`);
            reasons.push(`文档包含 ${docx.hiddenText.count} 处隐藏文字（${parts.join("、")}），肉眼不可见但可复制提取`);
        }
    }

    // ============================================================
    // 2. 图片检测项
    // ============================================================
    if (analysisResult.image && !analysisResult.image.error) {
        const img = analysisResult.image;

        // GPS 位置信息（高危）
        if (img.gps && img.gps.hasGps) {
            details.image_gps = RISK_WEIGHTS.image_gps;
            totalScore += RISK_WEIGHTS.image_gps;
            reasons.push(`照片包含 GPS 位置信息：${img.gps.formatted}`);
        }

        // 敏感 EXIF 信息
        if (img.exif && img.exif.hasSensitive) {
            details.image_exif_sensitive = RISK_WEIGHTS.image_exif_sensitive;
            totalScore += RISK_WEIGHTS.image_exif_sensitive;
            const cam = (img.exif.cameraMake + " " + img.exif.cameraModel).trim();
            reasons.push(`照片包含设备信息：${cam || "未知设备"}`);
        }

        // 缩略图与主图不一致（高危）
        if (img.thumbnail && img.thumbnail.isDiff) {
            details.image_thumbnail_diff = RISK_WEIGHTS.image_thumbnail_diff;
            totalScore += RISK_WEIGHTS.image_thumbnail_diff;
            reasons.push(`缩略图与主图差异达 ${img.thumbnail.diffPercent.toFixed(1)}%，缩略图可能泄露原始内容`);
        }

        // 图片内容中的个人信息（PII）
        if (img.pii && img.pii.hasPii && img.pii.items && img.pii.items.length > 0) {
            const piiItems = img.pii.items;

            // 统计各类型数量
            const idCardCount = piiItems.filter(i => i.type === "id_card").length;
            const phoneCount = piiItems.filter(i => i.type === "phone").length;
            const nameCount = piiItems.filter(i => i.type === "name").length;
            const addressCount = piiItems.filter(i => i.type === "address").length;

            // 身份证号（高危）
            if (idCardCount > 0) {
                details.image_pii_id_card = RISK_WEIGHTS.image_pii_id_card;
                totalScore += RISK_WEIGHTS.image_pii_id_card;
                reasons.push(`图片中检测到 ${idCardCount} 个身份证号，属于高度敏感个人信息`);
            }

            // 手机号
            if (phoneCount > 0) {
                details.image_pii_phone = RISK_WEIGHTS.image_pii_phone;
                totalScore += RISK_WEIGHTS.image_pii_phone;
                reasons.push(`图片中检测到 ${phoneCount} 个手机号`);
            }

            // 地址
            if (addressCount > 0) {
                details.image_pii_address = RISK_WEIGHTS.image_pii_address;
                totalScore += RISK_WEIGHTS.image_pii_address;
                reasons.push(`图片中检测到 ${addressCount} 个地址信息`);
            }

            // 姓名
            if (nameCount > 0) {
                details.image_pii_name = RISK_WEIGHTS.image_pii_name;
                totalScore += RISK_WEIGHTS.image_pii_name;
                reasons.push(`图片中检测到 ${nameCount} 个姓名`);
            }
        } else if (img.pii && img.pii.error) {
            // OCR 失败或不可用，提示用户（不影响风险评分）
            reasons.push(`ℹ️ 图片内容识别未启用：${img.pii.error}`);
        } else if (img.pii && img.pii.ocrAvailable && (!img.pii.hasPii || img.pii.items.length === 0)) {
            // OCR 成功运行但未检测到 PII
            reasons.push("ℹ️ 已扫描图片内容，未检测到身份证号、手机号、姓名、地址等个人信息");
        }
    }

    // ============================================================
    // 2.5 xlsx 检测项
    // ============================================================
    if (analysisResult.xlsx && !analysisResult.xlsx.error) {
        const xlsx = analysisResult.xlsx;

        // 白字/同色隐藏文字（高危）
        const hiddenText = xlsx.hidden && xlsx.hidden.items.filter(it => it.type === "白字隐藏" || it.type === "同色隐藏");
        if (hiddenText && hiddenText.length > 0) {
            details.xlsx_hidden_text = RISK_WEIGHTS.xlsx_hidden_text;
            totalScore += RISK_WEIGHTS.xlsx_hidden_text;
            reasons.push(`Excel 中有 ${hiddenText.length} 处白字/同色隐藏文字（如「${hiddenText[0].text}」），肉眼不可见但数据可读`);
        }

        // 隐藏行/列
        const rowcol = xlsx.hidden && xlsx.hidden.items.filter(it => it.type === "隐藏行" || it.type === "隐藏列");
        if (rowcol && rowcol.length > 0) {
            details.xlsx_hidden_rowcol = RISK_WEIGHTS.xlsx_hidden_rowcol;
            totalScore += RISK_WEIGHTS.xlsx_hidden_rowcol;
            reasons.push(`Excel 中有 ${rowcol.length} 处隐藏行/列`);
        }

        // 隐藏工作表
        const hiddenSheets = xlsx.hidden && xlsx.hidden.items.filter(it => it.type === "隐藏工作表");
        if (hiddenSheets && hiddenSheets.length > 0) {
            details.xlsx_hidden_sheet = RISK_WEIGHTS.xlsx_hidden_sheet;
            totalScore += RISK_WEIGHTS.xlsx_hidden_sheet;
            reasons.push(`Excel 中有 ${hiddenSheets.length} 个隐藏工作表（如「${(hiddenSheets[0].sheet || "").slice(0, 20)}」），可能含敏感数据`);
        }

        // 单元格批注
        if (xlsx.comments && xlsx.comments.hasComments) {
            details.xlsx_comments = RISK_WEIGHTS.xlsx_comments;
            totalScore += RISK_WEIGHTS.xlsx_comments;
            reasons.push(`Excel 中有 ${xlsx.comments.count} 条单元格批注（作者：${xlsx.comments.items[0]?.author || "未知"}）`);
        }

        // 元数据
        if (xlsx.metadata && xlsx.metadata.hasSensitive) {
            details.xlsx_metadata = RISK_WEIGHTS.xlsx_metadata;
            totalScore += RISK_WEIGHTS.xlsx_metadata;
            reasons.push(`Excel 元数据包含作者信息：${xlsx.metadata.author || xlsx.metadata.lastModifiedBy || "未知"}`);
        }
    }

    // ============================================================
    // 2.6 pptx 检测项
    // ============================================================
    if (analysisResult.pptx && !analysisResult.pptx.error) {
        const pptx = analysisResult.pptx;
        const hidden = pptx.hidden || { items: [] };

        // 演讲者备注页（高危）
        const notes = hidden.items.filter(it => it.type === "备注页");
        if (notes.length > 0) {
            details.pptx_notes = RISK_WEIGHTS.pptx_notes;
            totalScore += RISK_WEIGHTS.pptx_notes;
            reasons.push(`PPT 含 ${notes.length} 页演讲者备注（如「${(notes[0].text || "").slice(0, 40)}…」），观众看不到但文件里有`);
        }

        // 隐藏幻灯片
        const hidSlides = hidden.items.filter(it => it.type === "隐藏幻灯片");
        if (hidSlides.length > 0) {
            details.pptx_hidden_slide = RISK_WEIGHTS.pptx_hidden_slide;
            totalScore += RISK_WEIGHTS.pptx_hidden_slide;
            reasons.push(`PPT 有 ${hidSlides.length} 处隐藏幻灯片（可能含敏感内容）`);
        }

        // 批注
        if (pptx.comments && pptx.comments.hasComments) {
            details.pptx_comments = RISK_WEIGHTS.pptx_comments;
            totalScore += RISK_WEIGHTS.pptx_comments;
            reasons.push(`PPT 中有 ${pptx.comments.count} 条批注（作者：${pptx.comments.items[0]?.author || "未知"}）`);
        }

        // 元数据
        if (pptx.metadata && pptx.metadata.hasSensitive) {
            details.pptx_metadata = RISK_WEIGHTS.pptx_metadata;
            totalScore += RISK_WEIGHTS.pptx_metadata;
            reasons.push(`PPT 元数据包含作者信息：${pptx.metadata.author || pptx.metadata.lastModifiedBy || "未知"}`);
        }
    }

    // ============================================================
    // 2.7 doc(旧版 Word) 检测项
    // ============================================================
    if (analysisResult.doc && !analysisResult.doc.error) {
        const doc = analysisResult.doc;
        if (doc.hasSensitive) {
            details.doc_metadata = RISK_WEIGHTS.doc_metadata;
            totalScore += RISK_WEIGHTS.doc_metadata;
            reasons.push(`.doc 文档元数据包含 ${doc.author ? "作者：" + doc.author : ""}${doc.lastModifiedBy ? " 最后保存者：" + doc.lastModifiedBy : ""}${doc.comments ? " 备注：" + doc.comments : ""}`);
        }
    }

    // ============================================================
    // 3. PDF 检测项
    // ============================================================
    if (analysisResult.pdf && !analysisResult.pdf.error) {
        const pdf = analysisResult.pdf;

        // 增量保存
        if (pdf.incremental && pdf.incremental.hasIncremental) {
            details.pdf_incremental = RISK_WEIGHTS.pdf_incremental;
            totalScore += RISK_WEIGHTS.pdf_incremental;
            reasons.push(`PDF 包含 ${pdf.incremental.versionCount} 个历史版本，可能残留已删除内容`);
        }

        // 假黑框（高危）
        if (pdf.fakeRedaction && pdf.fakeRedaction.hasFakeRedaction) {
            details.pdf_fake_redaction = RISK_WEIGHTS.pdf_fake_redaction;
            totalScore += RISK_WEIGHTS.pdf_fake_redaction;
            reasons.push(`检测到 ${pdf.fakeRedaction.count} 处假遮挡：文字被矩形覆盖但仍可复制提取`);
        }

        // 元数据
        if (pdf.metadata && pdf.metadata.hasSensitive) {
            details.pdf_metadata = RISK_WEIGHTS.pdf_metadata;
            totalScore += RISK_WEIGHTS.pdf_metadata;
            // 优先显示作者，没有作者就显示生成工具
            const metaInfo = pdf.metadata.author || pdf.metadata.creator || pdf.metadata.producer || "未知";
            reasons.push(`PDF 元数据包含敏感信息：${metaInfo}`);
        }

        // 批注/注释
        if (pdf.annotations && pdf.annotations.hasAnnotations) {
            details.pdf_annotations = RISK_WEIGHTS.pdf_annotations;
            totalScore += RISK_WEIGHTS.pdf_annotations;
            reasons.push(`PDF 包含 ${pdf.annotations.count} 条批注/注释，可能泄露内部沟通信息`);
        }
    }

    // ============================================================
    // 4. 分数封顶 + 风险等级判断
    // ============================================================

    // 总分不能超过 100
    totalScore = Math.min(totalScore, 100);

    // 检查是否命中高危项
    for (const key of HIGH_RISK_KEYS) {
        if (details[key]) {
            hasHighRisk = true;
            break;
        }
    }

    // 确定风险等级
    // 只要检出任何问题（reasons 非空），最低就是"中等"（黄）；"安全"（绿）只留给完全没查到泄露的文件
    let level;
    if (hasHighRisk || totalScore >= 61) {
        level = "high";      // 高风险（红）
    } else if (totalScore >= 31 || reasons.length > 0) {
        level = "medium";    // 中等风险（黄）
    } else {
        level = "safe";      // 安全（绿）
    }

    // 如果没有任何风险，加一条安全提示
    if (reasons.length === 0) {
        reasons.push("未检测到明显的隐性泄露风险");
    }

    return {
        score: Math.round(totalScore),  // 取整
        level,                          // 等级
        details,                        // 各分项得分
        reasons,                        // 原因列表
        hasHighRisk,                    // 是否有高危项
    };
}

// ============================================================
// 导出到全局
// ============================================================
window.calculateRisk = calculateRisk;
window.RISK_WEIGHTS = RISK_WEIGHTS;
