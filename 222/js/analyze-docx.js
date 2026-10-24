/**
 * analyze-docx.js — DOCX 文件分析模块
 *
 * DOCX 文件本质是一个 ZIP 压缩包，里面装了一堆 XML 文件。
 * 我们用 JSZip 解压后，读取关键的 XML 文件来提取信息。
 *
 * 主要检测项：
 *   1. 元数据泄露（作者、修改者、创建时间等）
 *   2. 修订记录残留（插入/删除/格式修改的痕迹）
 *   3. 批注残留（其他人的评论）
 *   4. 隐藏文字（同色背景、vanish 隐藏格式、极小字号）
 *
 * 依赖：JSZip（通过 CDN 或本地 lib 目录引入，全局变量为 JSZip）
 *
 * 返回格式（统一结果对象）：
 * {
 *   metadata: { author, lastModifiedBy, created, modified, ... },
 *   revisions: { count, insertions: [...], deletions: [...], formatChanges: [...] },
 *   comments: { count, items: [{ author, date, text, ... }] },
 *   hiddenText: { hasHiddenText, count, items: [{ type, text, color, bgColor, fontSize, ... }] },
 *   error: null 或 错误信息
 * }
 */

/**
 * 分析一个 DOCX 文件，返回所有检测结果
 * @param {File|ArrayBuffer} fileInput - 文件对象或二进制数据
 * @returns {Promise<Object>} - 检测结果对象
 *
 * 使用方式：
 *   const result = await analyzeDocx(file);
 *   console.log(result.metadata.author);   // 作者名
 *   console.log(result.revisions.count);   // 修订记录数
 *   console.log(result.comments.count);    // 批注数
 */
async function analyzeDocx(fileInput) {
    // 结果对象，先把每个字段初始化好，后面逐项填充
    const result = {
        metadata: null,       // 元数据结果
        revisions: null,      // 修订记录结果
        comments: null,       // 批注结果
        hiddenText: null,     // 隐藏文字结果
        error: null,          // 错误信息（正常时为 null）
    };

    try {
        // 第一步：获取文件的 ArrayBuffer（二进制数据）
        let buffer;
        let fileSize = 0;
        if (fileInput instanceof File) {
            // 如果传的是 File 对象，用工具函数转成 ArrayBuffer
            fileSize = fileInput.size;
            buffer = await Utils.withTimeout(
                Utils.readFileAsArrayBuffer(fileInput),
                Utils.PARSE_TIMEOUTS.docx,
                "文件读取超时"
            );
        } else {
            // 如果已经是 ArrayBuffer 了，直接用
            fileSize = fileInput.byteLength;
            buffer = fileInput;
        }

        // 第二步：用 JSZip 解压 DOCX（DOCX 就是个 ZIP 包）
        // loadAsync 接收二进制数据，返回一个 zip 对象，可以读取里面的文件
        const zip = await Utils.withTimeout(
            JSZip.loadAsync(buffer),
            Utils.PARSE_TIMEOUTS.docx,
            "DOCX 解压超时，可能是畸形文件"
        );

        // ---- DoS 防护：ZIP 炸弹检测 ----
        // 估算解压后总大小，如果远大于压缩前大小，可能是压缩炸弹
        let estimatedUncompressed = 0;
        let entryCount = 0;
        zip.forEach((relativePath, zipEntry) => {
            entryCount++;
            // JSZip 的 _data 获取解压后大小（内部属性，尽量兼容）
            const uncompSize = zipEntry._data && zipEntry._data.uncompressedSize
                ? zipEntry._data.uncompressedSize
                : zipEntry._data && zipEntry._data.compressedSize
                    ? zipEntry._data.compressedSize * 3  // 粗略估算
                    : 0;
            estimatedUncompressed += uncompSize;
        });

        // DoS 防护：ZIP 条目数上限（防止"条目炸弹"，几十万个小文件卡死浏览器）
        if (entryCount > Utils.ZIP_MAX_ENTRIES) {
            throw new Error(`ZIP 内文件过多（${entryCount} 个），最多支持 ${Utils.ZIP_MAX_ENTRIES} 个，可能是恶意文件`);
        }

        if (fileSize > 0 && estimatedUncompressed > Utils.ZIP_BOMB_MAX_UNCOMPRESSED) {
            throw new Error(`文件解压后过大（约 ${Utils.formatBytes(estimatedUncompressed)}），可能是压缩炸弹，已终止解析`);
        }
        if (fileSize > 0 && estimatedUncompressed / fileSize > Utils.ZIP_BOMB_RATIO) {
            throw new Error(`文件压缩比异常（${Math.round(estimatedUncompressed / fileSize)} 倍），可能是压缩炸弹，已终止解析`);
        }

        // 第三步：分别检测四个项目
        // 用 Promise.all 同时跑，提高效率
        const [metaResult, revResult, commResult, hiddenResult] = await Promise.all([
            extractDocxMetadata(zip),       // 提取元数据
            extractDocxRevisions(zip),      // 提取修订记录
            extractDocxComments(zip),       // 提取批注
            extractDocxHiddenText(zip),     // 检测隐藏文字
        ]);

        // 把结果填进去
        result.metadata = metaResult;
        result.revisions = revResult;
        result.comments = commResult;
        result.hiddenText = hiddenResult;

    } catch (err) {
        // 任何一步出错，都把错误信息存到 result.error 里
        result.error = err.message || "未知错误";
    }

    return result;
}

// ============================================================
// 1. 元数据提取
// ============================================================

/**
 * 从 DOCX 的 ZIP 中提取元数据
 * @param {JSZip} zip - JSZip 实例
 * @returns {Promise<Object>} - 元数据对象
 *
 * 元数据存在 docProps/core.xml 文件里，格式是 XML，
 * 里面有 <dc:creator>（作者）、<cp:lastModifiedBy>（最后修改者）等节点。
 */
async function extractDocxMetadata(zip) {
    // 结果对象，默认值都是空
    const meta = {
        author: "",          // 作者（创建文档的人）
        lastModifiedBy: "",  // 最后修改者
        created: "",         // 创建时间
        modified: "",        // 最后修改时间
        title: "",           // 标题
        subject: "",         // 主题
        hasSensitive: false, // 是否包含敏感元数据（作者名等就算敏感）
    };

    try {
        // 从 ZIP 中找到 docProps/core.xml 文件，读取为文本
        const coreXml = await zip.file("docProps/core.xml").async("string");
        // 把 XML 文本解析成 DOM 对象，方便用 getElementsByTagName 查找
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(coreXml, "text/xml");

        // 提取各个字段——用命名空间前缀找标签
        // <dc:creator> → 标签名是 "dc:creator"
        meta.author = getXmlText(xmlDoc, "dc:creator");
        meta.lastModifiedBy = getXmlText(xmlDoc, "cp:lastModifiedBy");
        meta.created = getXmlText(xmlDoc, "dcterms:created");
        meta.modified = getXmlText(xmlDoc, "dcterms:modified");
        meta.title = getXmlText(xmlDoc, "dc:title");
        meta.subject = getXmlText(xmlDoc, "dc:subject");

        // 判断是否有敏感信息：有作者名或修改者名就算
        meta.hasSensitive = !!(meta.author || meta.lastModifiedBy);

    } catch (err) {
        // core.xml 可能不存在（极少数情况），此时保持默认值即可
        // 不抛出错误，因为元数据不是必须的
    }

    return meta;
}

/**
 * 从 XML 文档中获取指定标签的文本内容
 * @param {Document} xmlDoc - XML DOM 文档
 * @param {string} tagName - 标签名（带命名空间前缀，如 "dc:creator"）
 * @returns {string} - 文本内容，找不到返回空字符串
 */
function getXmlText(xmlDoc, tagName) {
    // 按标签名查找，返回一个 NodeList
    const elements = xmlDoc.getElementsByTagName(tagName);
    // 如果找到至少一个，取第一个的文本内容
    if (elements.length > 0) {
        return elements[0].textContent.trim();
    }
    return "";
}

// ============================================================
// 2. 修订记录提取
// ============================================================

/**
 * 从 DOCX 中提取修订记录（插入、删除、格式修改）
 * @param {JSZip} zip - JSZip 实例
 * @returns {Promise<Object>} - 修订记录结果
 *
 * 修订记录在 word/document.xml 里，用这些标签表示：
 *   <w:ins>        —— 插入的内容
 *   <w:del>        —— 删除的内容（里面的文字在 <w:delText> 里）
 *   <w:rPrChange>  —— 格式修改
 *   每个修订节点都有 w:author（作者）和 w:date（时间）属性
 */
async function extractDocxRevisions(zip) {
    // 结果对象
    const result = {
        count: 0,              // 总修订数
        insertions: [],        // 插入记录列表
        deletions: [],         // 删除记录列表（最敏感，删了什么还能看到）
        formatChanges: [],     // 格式修改列表
        hasRevisions: false,   // 是否有修订
    };

    // DoS 防护：最多提取多少条修订记录，防止海量记录占满内存
    const MAX_REVISIONS = 5000;
    const MAX_TEXT_LEN = 500;   // 单条修订内容最大长度

    try {
        // 读取 document.xml（文档主体内容）
        const docXml = await zip.file("word/document.xml").async("string");
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(docXml, "text/xml");

        // --- 提取插入记录 <w:ins> ---
        // 获取所有 <w:ins> 元素
        const insElements = xmlDoc.getElementsByTagName("w:ins");
        // 遍历每一个，提取作者、时间、插入的文字（最多 MAX_REVISIONS 条）
        const insLimit = Math.min(insElements.length, MAX_REVISIONS);
        for (let i = 0; i < insLimit; i++) {
            const ins = insElements[i];
            result.insertions.push({
                // w:author 属性 → 谁插入的
                author: ins.getAttribute("w:author") || "未知",
                // w:date 属性 → 什么时候插入的
                date: ins.getAttribute("w:date") || "",
                // 提取这个节点里所有文字（就是插入的内容），并截断
                text: Utils.truncate(ins.textContent.trim(), MAX_TEXT_LEN),
            });
        }

        // --- 提取删除记录 <w:del> ---
        // 获取所有 <w:del> 元素
        const delElements = xmlDoc.getElementsByTagName("w:del");
        const delLimit = Math.min(delElements.length, MAX_REVISIONS);
        for (let i = 0; i < delLimit; i++) {
            const del = delElements[i];
            // 删除的文字在 <w:delText> 里，而不是普通的 <w:t>
            const delTexts = del.getElementsByTagName("w:delText");
            let deletedText = "";
            for (let j = 0; j < delTexts.length; j++) {
                deletedText += delTexts[j].textContent;
                if (deletedText.length > MAX_TEXT_LEN) break; // 提前截断
            }
            result.deletions.push({
                author: del.getAttribute("w:author") || "未知",
                date: del.getAttribute("w:date") || "",
                text: Utils.truncate(deletedText.trim(), MAX_TEXT_LEN),
            });
        }

        // --- 提取格式修改 <w:rPrChange> ---
        const rPrChanges = xmlDoc.getElementsByTagName("w:rPrChange");
        const fmtLimit = Math.min(rPrChanges.length, MAX_REVISIONS);
        for (let i = 0; i < fmtLimit; i++) {
            const change = rPrChanges[i];
            result.formatChanges.push({
                author: change.getAttribute("w:author") || "未知",
                date: change.getAttribute("w:date") || "",
            });
        }

        // 计算总数
        result.count = result.insertions.length + result.deletions.length + result.formatChanges.length;
        result.hasRevisions = result.count > 0;

    } catch (err) {
        // 读取失败时保持默认值（count=0）
    }

    return result;
}

// ============================================================
// 3. 批注提取
// ============================================================

/**
 * 从 DOCX 中提取批注（评论）
 * @param {JSZip} zip - JSZip 实例
 * @returns {Promise<Object>} - 批注结果
 *
 * 批注存在 word/comments.xml 文件里，每条批注是一个 <w:comment> 节点，
 * 包含 w:id（编号）、w:author（作者）、w:date（时间）等属性。
 */
async function extractDocxComments(zip) {
    const result = {
        count: 0,          // 批注总数
        items: [],         // 每条批注的详情
        hasComments: false, // 是否有批注
    };

    // DoS 防护：最多提取多少条批注
    const MAX_COMMENTS = 2000;
    const MAX_TEXT_LEN = 500;

    try {
        // 批注文件可能不存在（没有批注时就没有这个文件）
        const commentsFile = zip.file("word/comments.xml");
        if (!commentsFile) {
            // 文件不存在说明没有批注，直接返回
            return result;
        }

        // 读取并解析 comments.xml
        const commentsXml = await commentsFile.async("string");
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(commentsXml, "text/xml");

        // 获取所有 <w:comment> 元素
        const commentElements = xmlDoc.getElementsByTagName("w:comment");
        const commentLimit = Math.min(commentElements.length, MAX_COMMENTS);
        for (let i = 0; i < commentLimit; i++) {
            const comment = commentElements[i];
            result.items.push({
                // w:id 属性 → 批注编号
                id: comment.getAttribute("w:id") || "",
                // w:author 属性 → 批注作者
                author: comment.getAttribute("w:author") || "未知",
                // w:date 属性 → 批注时间
                date: comment.getAttribute("w:date") || "",
                // 批注内容（节点里的所有文字），并截断
                text: Utils.truncate(comment.textContent.trim(), MAX_TEXT_LEN),
            });
        }

        result.count = result.items.length;
        result.hasComments = result.count > 0;

    } catch (err) {
        // 出错时保持默认值
    }

    return result;
}

// ============================================================
// 4. 隐藏文字检测（同色背景 / vanish 隐藏 / 极小字号）
// ============================================================

/**
 * 检测 DOCX 中的隐藏文字
 * 检测类型：
 *   - same_color: 文字颜色与背景色相同或极接近（同色隐藏）
 *   - vanish: Word 自带的"隐藏文字"格式（<w:vanish/>）
 *   - tiny_font: 字号极小（≤2pt），肉眼几乎不可见
 *
 * @param {JSZip} zip - JSZip 实例
 * @returns {Promise<Object>} - 隐藏文字检测结果
 */
async function extractDocxHiddenText(zip) {
    const result = {
        hasHiddenText: false,    // 是否检测到隐藏文字
        count: 0,                // 隐藏文字片段总数
        items: [],               // 各隐藏片段详情
        sameColorCount: 0,       // 同色隐藏数量
        vanishCount: 0,          // vanish 隐藏数量
        tinyFontCount: 0,        // 极小字号数量
    };

    const MAX_ITEMS = 500;       // 最多记录多少条（防止海量数据）
    const MAX_TEXT_LEN = 200;    // 单条文本最长字符数

    try {
        // 1. 读取 document.xml
        const docXml = await zip.file("word/document.xml").async("string");
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(docXml, "text/xml");

        // 2. 读取页面背景色（<w:background w:color="..."/>）
        //    默认白色 "FFFFFF"
        let pageBgColor = "FFFFFF";
        const bgEl = xmlDoc.getElementsByTagName("w:background")[0];
        if (bgEl) {
            const bgColor = bgEl.getAttribute("w:color");
            if (bgColor && bgColor !== "auto") {
                pageBgColor = bgColor.toUpperCase();
            }
        }

        // 3. 读取 styles.xml，获取默认段落/文字样式中的颜色
        let defaultTextColor = null;  // 默认文字颜色（Normal 样式里的）
        const stylesFile = zip.file("word/styles.xml");
        if (stylesFile) {
            const stylesXml = await stylesFile.async("string");
            const stylesDoc = parser.parseFromString(stylesXml, "text/xml");

            // 找 docDefaults 里的默认文字颜色
            const docDefaults = stylesDoc.getElementsByTagName("w:docDefaults")[0];
            if (docDefaults) {
                const rPr = docDefaults.getElementsByTagName("w:rPr")[0];
                if (rPr) {
                    const colorEl = rPr.getElementsByTagName("w:color")[0];
                    if (colorEl) {
                        const val = colorEl.getAttribute("w:val");
                        if (val && val !== "auto") defaultTextColor = val.toUpperCase();
                    }
                }
            }
        }

        // 4. 遍历所有段落 <w:p>，逐个检查其中的 <w:r>（文字运行）
        const paragraphs = xmlDoc.getElementsByTagName("w:p");
        const paraLimit = Math.min(paragraphs.length, 5000); // 段落数上限

        for (let i = 0; i < paraLimit; i++) {
            const p = paragraphs[i];

            // 段落级背景色（<w:shd w:fill="..."/>）
            let paraBgColor = null;
            const pPr = p.getElementsByTagName("w:pPr")[0];
            if (pPr) {
                const shd = pPr.getElementsByTagName("w:shd")[0];
                if (shd) {
                    const fill = shd.getAttribute("w:fill");
                    if (fill && fill !== "auto") paraBgColor = fill.toUpperCase();
                }
            }

            // 本段实际背景色：段落背景 > 页面背景
            const effectiveBg = paraBgColor || pageBgColor;

            // 遍历本段所有文字运行 <w:r>
            const runs = p.getElementsByTagName("w:r");
            for (let j = 0; j < runs.length; j++) {
                if (result.items.length >= MAX_ITEMS) break;

                const run = runs[j];
                const rPr = run.getElementsByTagName("w:rPr")[0];

                // 提取文字内容
                const tEl = run.getElementsByTagName("w:t")[0];
                if (!tEl) continue;
                const text = tEl.textContent || "";
                if (!text.trim()) continue;  // 空白文字跳过

                // ---- 检测 1：vanish 隐藏文字 ----
                if (rPr) {
                    const vanish = rPr.getElementsByTagName("w:vanish")[0];
                    if (vanish) {
                        result.items.push({
                            type: "vanish",
                            text: Utils.truncate(text, MAX_TEXT_LEN),
                            description: "Word 隐藏文字格式（勾选了「隐藏」效果）",
                        });
                        result.vanishCount++;
                        continue; // 已经算隐藏了，不再重复检测同色
                    }
                }

                // ---- 检测 2：极小字号 ----
                if (rPr) {
                    const szEl = rPr.getElementsByTagName("w:sz")[0];
                    if (szEl) {
                        const szHalf = parseInt(szEl.getAttribute("w:val"), 10);
                        // w:sz 的单位是半点（half-point），所以 sz/2 = 磅数
                        const fontSizePt = szHalf / 2;
                        if (!isNaN(fontSizePt) && fontSizePt <= 2 && fontSizePt > 0) {
                            result.items.push({
                                type: "tiny_font",
                                text: Utils.truncate(text, MAX_TEXT_LEN),
                                fontSize: fontSizePt + "pt",
                                description: `极小字号（${fontSizePt}pt），肉眼几乎不可见`,
                            });
                            result.tinyFontCount++;
                            continue;
                        }
                    }
                }

                // ---- 检测 3：同色背景隐藏 ----
                // 文字颜色可能来自：
                //   a. <w:color w:val="..."/> （run 级）
                //   b. 继承自段落样式 / 默认样式
                //   c. 主题色引用（themeColor）—— 简化处理：主题色视为"跟随主题"，暂不深度解析
                let textColor = null;
                if (rPr) {
                    const colorEl = rPr.getElementsByTagName("w:color")[0];
                    if (colorEl) {
                        const val = colorEl.getAttribute("w:val");
                        // auto = 自动（通常是黑/白，跟随主题），不算明确的同色
                        if (val && val !== "auto") {
                            textColor = val.toUpperCase();
                        }
                    }
                }

                // 如果 run 没有显式颜色，用默认文字颜色
                if (!textColor && defaultTextColor) {
                    textColor = defaultTextColor;
                }

                if (textColor && effectiveBg) {
                    // 计算颜色差异（欧氏距离）
                    const dist = colorDistance(textColor, effectiveBg);
                    // 颜色非常接近（距离 < 30），认为是同色隐藏
                    if (dist < 30) {
                        result.items.push({
                            type: "same_color",
                            text: Utils.truncate(text, MAX_TEXT_LEN),
                            textColor: "#" + textColor,
                            bgColor: "#" + effectiveBg,
                            colorDistance: dist,
                            description: `文字颜色 #${textColor} 与背景色 #${effectiveBg} 几乎一致，肉眼不可见但可复制`,
                        });
                        result.sameColorCount++;
                    }
                }
            }

            if (result.items.length >= MAX_ITEMS) break;
        }

        result.count = result.items.length;
        result.hasHiddenText = result.count > 0;

    } catch (err) {
        // 解析出错时保持默认值（不影响其他检测项）
        console.warn("[DOCX] 隐藏文字检测失败:", err.message);
    }

    return result;
}

/**
 * 计算两个十六进制颜色的欧氏距离（RGB 空间）
 * 距离越小，颜色越接近；0 表示完全相同
 * @param {string} hex1 - 6 位十六进制颜色（不带 #）
 * @param {string} hex2 - 6 位十六进制颜色（不带 #）
 * @returns {number} 颜色距离（0~441 左右）
 */
function colorDistance(hex1, hex2) {
    // 确保是 6 位十六进制
    const c1 = hex1.replace(/[^0-9A-F]/gi, "").padEnd(6, "0").substring(0, 6);
    const c2 = hex2.replace(/[^0-9A-F]/gi, "").padEnd(6, "0").substring(0, 6);

    const r1 = parseInt(c1.substring(0, 2), 16);
    const g1 = parseInt(c1.substring(2, 4), 16);
    const b1 = parseInt(c1.substring(4, 6), 16);

    const r2 = parseInt(c2.substring(0, 2), 16);
    const g2 = parseInt(c2.substring(2, 4), 16);
    const b2 = parseInt(c2.substring(4, 6), 16);

    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;

    return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ============================================================
// 导出到全局
// ============================================================
window.analyzeDocx = analyzeDocx;
