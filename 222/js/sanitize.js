/**
 * sanitize.js — 文件清洗（脱敏）模块
 *
 * 检测出风险后，提供一键清洗功能，把敏感信息去掉。
 *
 * 支持的清洗：
 *   1. DOCX 清洗 —— 删除修订记录、清除批注、擦除元数据
 *   2. 图片清洗 —— Canvas 重绘导出（自动清除 EXIF）
 *   3. PDF 清洗 —— 检测到隐形文字/批注时"重渲染脱敏"（真正移除文字层，支持任意背景色）；
 *                  否则只清除元数据（保留可编辑性）
 *
 * 所有清洗函数返回 Blob 对象（可以直接下载）。
 */

/**
 * 清洗文件的入口函数，根据文件类型自动调用对应的清洗方法
 * @param {File} file - 原始文件
 * @param {Object} [analysisResult] - 已有的分析结果（用于判断 PDF 是否需要深度清洗）
 * @param {Object} [options] - 清洗选项（如图片的 PII 选择性打码）
 * @param {Array} [options.piiItems] - 需要打码的个人信息项（仅图片有效）
 * @returns {Promise<{ blob: Blob, filename: string, cleaned: boolean, error: string|null }>}
 *
 * 使用方式：
 *   const result = await sanitizeFile(file, currentResult);
 *   if (result.cleaned) {
 *     downloadBlob(result.blob, result.filename);
 *   }
 */
async function sanitizeFile(file, analysisResult, options) {
    const result = {
        blob: null,        // 清洗后的文件 blob
        filename: "",      // 清洗后的文件名
        cleaned: false,    // 是否清洗成功
        error: null,       // 错误信息
    };

    // 获取文件类型
    const fileType = Utils.getFileType(file);

    try {
        if (fileType === "docx") {
            // DOCX 清洗（支持选择性清洗）
            const docxOpts = options && options.docx ? options.docx : {};
            const cleanedBlob = await sanitizeDocx(file, docxOpts);
            result.blob = cleanedBlob;
            result.filename = makeCleanedFilename(file.name);
            result.cleaned = true;
        }
        else if (fileType === "image") {
            // 图片清洗（支持选择性 PII 打码）
            const piiItems = options && options.piiItems ? options.piiItems : null;
            const allTextItems = options && options.allTextItems ? options.allTextItems : null;
            const cleanedBlob = await sanitizeImage(file, piiItems, allTextItems);
            result.blob = cleanedBlob;
            result.filename = makeCleanedFilename(file.name);
            result.cleaned = true;
        }
        else if (fileType === "pdf") {
            // PDF 清洗：
            //   - 检测到隐形文字 → 重渲染脱敏（真正移除文字层）
            //   - 检测到批注：如果用户勾选"保留批注"，跳过重渲染只清元数据；否则重渲染
            const pdfRes = (analysisResult && analysisResult.pdf) || null;
            const hasHidden = pdfRes && pdfRes.fakeRedaction && pdfRes.fakeRedaction.hasFakeRedaction;
            const hasAnnots = pdfRes && pdfRes.annotations && pdfRes.annotations.hasAnnotations;
            const keepComments = options && options.keepComments ? options.keepComments : false;

            if (hasHidden) {
                // 有隐形文字必须重渲染
                result.blob = await sanitizePdfRedact(file);
            } else if (hasAnnots && !keepComments) {
                // 有批注且不保留 → 重渲染
                result.blob = await sanitizePdfRedact(file);
            } else {
                // 只清元数据
                result.blob = await sanitizePdfMetadata(file);
            }
            result.filename = makeCleanedFilename(file.name);
            result.cleaned = true;
        }
        else if (fileType === "xlsx") {
            // Excel 清洗：清元数据 + 删批注 + 删隐藏表（整表删除）+ 删隐藏行列（支持选择性）
            const xlsxOpts = options && options.xlsx ? options.xlsx : {};
            const cleanedBlob = await sanitizeXlsx(file, xlsxOpts);
            result.blob = cleanedBlob;
            result.filename = makeCleanedFilename(file.name);
            result.cleaned = true;
        }
        else if (fileType === "pptx") {
            // PPT 清洗：删隐藏幻灯片节点 + 删批注 + 清元数据（支持选择性）
            const pptxOpts = options && options.pptx ? options.pptx : {};
            const cleanedBlob = await sanitizePptx(file, pptxOpts);
            result.blob = cleanedBlob;
            result.filename = makeCleanedFilename(file.name);
            result.cleaned = true;
        }
        else {
            result.error = "不支持的文件类型";
        }
    } catch (err) {
        result.error = err.message || "清洗失败";
    }

    return result;
}

/**
 * 生成清洗后的文件名（在原文件名前加 "cleaned_"）
 * @param {string} originalName - 原文件名
 * @returns {string}
 */
function makeCleanedFilename(originalName) {
    // 找到最后一个点的位置，在前面插入 _cleaned
    const dotIndex = originalName.lastIndexOf(".");
    if (dotIndex === -1) {
        return originalName + "_cleaned";
    }
    return originalName.slice(0, dotIndex) + "_cleaned" + originalName.slice(dotIndex);
}

// ============================================================
// 1. DOCX 清洗
// ============================================================

/**
 * 清洗 DOCX 文件：删除修订记录、清除批注、擦除元数据、清除隐藏文字
 * @param {File} file - DOCX 文件
 * @returns {Promise<Blob>} - 清洗后的 Blob
 *
 * 原理：
 *   1. 用 JSZip 解压 DOCX
 *   2. 修改 word/document.xml，删除 <w:ins>、<w:del>、<w:rPrChange> 等修订节点
 *   3. 删除 word/comments.xml 文件（批注）
 *   4. 清空 docProps/core.xml 中的作者等敏感字段
 *   5. 清除隐藏文字（vanish 隐藏格式 / 极小字号 / 同色背景文字 → 全部移除）
 *   6. 重新打包成 ZIP（即新的 DOCX）
 */
async function sanitizeDocx(file, options = {}) {
    // 默认全部清洗
    const opts = {
        cleanMeta: true,
        cleanRevisions: true,
        cleanComments: true,
        cleanHidden: true,
        ...options
    };

    // 读取文件为 ArrayBuffer
    const buffer = await Utils.readFileAsArrayBuffer(file);

    // 解压
    const zip = await JSZip.loadAsync(buffer);

    // ---- 1. 清除 document.xml 中的修订记录 ----
    const docXmlPath = "word/document.xml";
    let docXml = await zip.file(docXmlPath).async("string");

    // 用正则删除修订节点（包括内容）
    // <w:ins ...>...</w:ins>  → 里面的内容要保留（接受插入）
    // <w:del ...>...</w:del>  → 里面的内容要删掉（接受删除）
    // <w:rPrChange>...</w:rPrChange> → 整个删掉（接受格式修改）

    // 关键前置：先剔除 XML 注释 <!-- ... -->（注释本身可能残留敏感信息）
    docXml = docXml.replace(/<!--[\s\S]*?-->/g, "");

    if (opts.cleanRevisions) {
        // 处理 <w:ins>：保留里面的文字（去掉 ins 标签，但保留内容）
        docXml = docXml.replace(/<w:ins[^>]*>([\s\S]*?)<\/w:ins>/g, "$1");

        // 处理 <w:del>：整个删掉（包括里面的 <w:delText>）
        docXml = docXml.replace(/<w:del[^>]*>[\s\S]*?<\/w:del>/g, "");

        // 处理 <w:rPrChange>：整个删掉
        docXml = docXml.replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, "");
    }

    if (opts.cleanComments) {
        // 处理 <w:commentRangeStart> / <w:commentRangeEnd>（批注引用范围标记）
        docXml = docXml.replace(/<w:commentRangeStart[^>]*\/>/g, "");
        docXml = docXml.replace(/<w:commentRangeEnd[^>]*\/>/g, "");
        // 处理 <w:commentReference>（批注引用标记）
        docXml = docXml.replace(/<w:commentReference[^>]*\/>/g, "");
    }

    // 把修改后的 document.xml 写回 zip
    zip.file(docXmlPath, docXml);

    // ---- 2. 删除批注文件 + 清理悬空引用 ----
    if (opts.cleanComments) {
        // 删除所有批注相关部件（含新版 Word 的扩展批注部件）
        const commentParts = [
            "word/comments.xml",
            "word/_rels/comments.xml.rels",
            "word/commentsExtended.xml",
            "word/_rels/commentsExtended.xml.rels",
            "word/commentsIds.xml",
            "word/_rels/commentsIds.xml.rels",
            "word/people.xml",
            "word/_rels/people.xml.rels",
        ];
        for (const p of commentParts) {
            if (zip.file(p)) zip.remove(p);
        }

        // 关键：清理 [Content_Types].xml 里指向已删批注部件的 <Override>
        const contentTypesPath = "[Content_Types].xml";
        if (zip.file(contentTypesPath)) {
            let ct = await zip.file(contentTypesPath).async("string");
            ct = ct.replace(/<Override\s+PartName="\/word\/(comments(?:Extended|Ids)?|people)\.xml"[^>]*\/>/g, "");
            zip.file(contentTypesPath, ct);
        }

        // 关键：清理 word/_rels/document.xml.rels 里指向已删批注部件的关系
        const docRelsPath = "word/_rels/document.xml.rels";
        if (zip.file(docRelsPath)) {
            let rels = await zip.file(docRelsPath).async("string");
            rels = rels.replace(
                /<Relationship[^>]*Type="[^"]*\/(comments(?:Extended|Ids)?|people)"[^>]*\/>/g,
                ""
            );
            zip.file(docRelsPath, rels);
        }
    }

    // ---- 3. 清除元数据 ----
    if (opts.cleanMeta) {
        const coreXmlPath = "docProps/core.xml";
        if (zip.file(coreXmlPath)) {
            let coreXml = await zip.file(coreXmlPath).async("string");
            // 清空作者、修改者
            coreXml = coreXml.replace(/<dc:creator>[^<]*<\/dc:creator>/g, "<dc:creator></dc:creator>");
            coreXml = coreXml.replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, "<cp:lastModifiedBy></cp:lastModifiedBy>");
            // 清空标题、主题
            coreXml = coreXml.replace(/<dc:title>[^<]*<\/dc:title>/g, "<dc:title></dc:title>");
            coreXml = coreXml.replace(/<dc:subject>[^<]*<\/dc:subject>/g, "<dc:subject></dc:subject>");
            // 补全：关键词、类别、创建时间、修改时间
            coreXml = coreXml.replace(/<cp:keywords>[^<]*<\/cp:keywords>/g, "<cp:keywords></cp:keywords>");
            coreXml = coreXml.replace(/<cp:category>[^<]*<\/cp:category>/g, "<cp:category></cp:category>");
            coreXml = coreXml.replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, "<dcterms:created></dcterms:created>");
            coreXml = coreXml.replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, "<dcterms:modified></dcterms:modified>");
            zip.file(coreXmlPath, coreXml);
        }
        // 补全：app.xml 里的公司、经理
        const appPath = "docProps/app.xml";
        if (zip.file(appPath)) {
            let appXml = await zip.file(appPath).async("string");
            appXml = appXml.replace(/<Company>[^<]*<\/Company>/g, "<Company></Company>");
            appXml = appXml.replace(/<Manager>[^<]*<\/Manager>/g, "<Manager></Manager>");
            zip.file(appPath, appXml);
        }
    }

    // ---- 4. 清除隐藏文字 ----
    if (opts.cleanHidden) {
        // 类型：
        //   a. vanish 隐藏格式 → 找到带 <w:vanish/> 的 <w:r>，整段删除（连同文字）
        //   b. 极小字号（≤2pt）→ 整段删除
        //   c. 同色背景隐藏 → 整段删除
        //
        // 注意：这一步需要先知道页面/段落背景色才能判断同色隐藏，
        // 为了稳妥起见，我们用 DOM 解析逐段检查。
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(docXml, "text/xml");

        // 读取页面背景色
        let pageBgColor = "FFFFFF";
        const bgEl = xmlDoc.getElementsByTagName("w:background")[0];
        if (bgEl) {
            const bgColor = bgEl.getAttribute("w:color");
            if (bgColor && bgColor !== "auto") pageBgColor = bgColor.toUpperCase();
        }

        // 遍历所有段落
        const paragraphs = xmlDoc.getElementsByTagName("w:p");
        // 收集要删除的 run 节点（不能在遍历的时候直接删，会影响集合）
        const runsToRemove = [];

        for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i];

            // 段落级背景色
            let paraBgColor = null;
            const pPr = p.getElementsByTagName("w:pPr")[0];
            if (pPr) {
                const shd = pPr.getElementsByTagName("w:shd")[0];
                if (shd) {
                    const fill = shd.getAttribute("w:fill");
                    if (fill && fill !== "auto") paraBgColor = fill.toUpperCase();
                }
            }
            const effectiveBg = paraBgColor || pageBgColor;

            // 遍历本段所有 run
            const runs = p.getElementsByTagName("w:r");
            for (let j = 0; j < runs.length; j++) {
                const run = runs[j];
                const rPr = run.getElementsByTagName("w:rPr")[0];
                if (!rPr) continue;

                let shouldRemove = false;
                let removeReason = "";

                // a) vanish 隐藏
                const vanish = rPr.getElementsByTagName("w:vanish")[0];
                if (vanish) {
                    shouldRemove = true;
                    removeReason = "vanish 隐藏格式";
                }

                // b) 极小字号（≤2pt）
                if (!shouldRemove) {
                    const szEl = rPr.getElementsByTagName("w:sz")[0];
                    if (szEl) {
                        const szHalf = parseInt(szEl.getAttribute("w:val"), 10);
                        const fontSizePt = szHalf / 2;
                        if (!isNaN(fontSizePt) && fontSizePt <= 2 && fontSizePt > 0) {
                            shouldRemove = true;
                            removeReason = `极小字号 ${fontSizePt}pt`;
                        }
                    }
                }

                // c) 同色背景隐藏
                if (!shouldRemove) {
                    const colorEl = rPr.getElementsByTagName("w:color")[0];
                    if (colorEl) {
                        const val = colorEl.getAttribute("w:val");
                        if (val && val !== "auto") {
                            const textColor = val.toUpperCase();
                            // 颜色距离 < 30 视为同色
                            const dist = colorDistanceHex(textColor, effectiveBg);
                            if (dist < 30) {
                                shouldRemove = true;
                                removeReason = `同色背景 (#${textColor})`;
                            }
                        }
                    }
                }

                if (shouldRemove) {
                    runsToRemove.push(run);
                }
            }
        }

        // 批量删除隐藏文字的 run
        for (const run of runsToRemove) {
            if (run.parentNode) {
                run.parentNode.removeChild(run);
            }
        }

        // 把修改后的 XML 序列化回去
        const serializer = new XMLSerializer();
        docXml = serializer.serializeToString(xmlDoc);
        zip.file(docXmlPath, docXml);

        console.log(`[DOCX 清洗] 已移除 ${runsToRemove.length} 处隐藏文字`);

    } catch (err) {
        console.warn("[DOCX 清洗] 隐藏文字清理失败（不影响其他清洗项）:", err.message);
    }
    } // end if (opts.cleanHidden)

    // ---- 5. 重新打包 ----
    // 生成新的 blob（type 设为 docx 的 MIME 类型）
    const cleanedBlob = await zip.generateAsync({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    return cleanedBlob;
}

/**
 * 计算两个十六进制颜色的欧氏距离（RGB 空间）
 * 距离越小颜色越接近，0 表示完全相同
 * @param {string} hex1 - 6 位十六进制颜色（不带 #）
 * @param {string} hex2 - 6 位十六进制颜色（不带 #）
 * @returns {number} 颜色距离
 */
function colorDistanceHex(hex1, hex2) {
    const c1 = hex1.replace(/[^0-9A-F]/gi, "").padEnd(6, "0").substring(0, 6);
    const c2 = hex2.replace(/[^0-9A-F]/gi, "").padEnd(6, "0").substring(0, 6);
    const r1 = parseInt(c1.substring(0, 2), 16);
    const g1 = parseInt(c1.substring(2, 4), 16);
    const b1 = parseInt(c1.substring(4, 6), 16);
    const r2 = parseInt(c2.substring(0, 2), 16);
    const g2 = parseInt(c2.substring(2, 4), 16);
    const b2 = parseInt(c2.substring(4, 6), 16);
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ============================================================
// 2. 图片清洗
// ============================================================

/**
 * 清洗图片：通过 Canvas 重绘导出，自动去除 EXIF 等元数据
 * 支持选择性 PII 打码：如果提供 piiItems，则在对应位置画黑框覆盖
 * @param {File} file - 图片文件
 * @param {Array<Object>} [piiItems] - 需要打码的个人信息项（含 bbox 坐标）
 * @returns {Promise<Blob>} - 清洗后的图片 Blob
 *
 * 原理：
 *   把图片画到 Canvas 上，再从 Canvas 导出成新的图片。
 *   Canvas 导出的图片只包含像素数据，不包含任何 EXIF 元数据。
 *   如果提供了 piiItems，则在对应位置用黑色矩形覆盖（打码）。
 */
async function sanitizeImage(file, piiItems, allTextItems) {
    // 马赛克打码：把 (x,y,w,h) 区域按 blockSize 逐块取平均色填充，像素化后破坏原始信息，
    // 比纯黑块更美观、更自然，且被覆盖内容无法还原（防反推）。
    function mosaicCover(ctx, x, y, w, h, blockSize) {
        const right = x + w;
        const bottom = y + h;
        for (let by = y; by < bottom; by += blockSize) {
            for (let bx = x; bx < right; bx += blockSize) {
                const bw = Math.min(blockSize, right - bx);
                const bh = Math.min(blockSize, bottom - by);
                let imgData;
                try { imgData = ctx.getImageData(bx, by, bw, bh); } catch (e) { continue; }
                let r = 0, g = 0, b = 0, a = 0, n = 0;
                for (let i = 0; i < imgData.data.length; i += 4) {
                    r += imgData.data[i];
                    g += imgData.data[i + 1];
                    b += imgData.data[i + 2];
                    a += imgData.data[i + 3];
                    n++;
                }
                n = n || 1;
                ctx.fillStyle = `rgba(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)},${Math.round(a / n)})`;
                ctx.fillRect(bx, by, bw, bh);
            }
        }
    }

    // 把文件转成 DataURL 来加载
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

    // 加载图片
    const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = dataUrl;
    });

    // 创建 Canvas，尺寸和原图一致
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");

    // 把图画到 Canvas 上
    ctx.drawImage(img, 0, 0);

    // 如果有需要打码的 PII 项，用马赛克覆盖（美观、破坏原始像素、不可还原）
    if (piiItems && piiItems.length > 0) {
        // 马赛克块大小：随图片尺寸自适应，保证既美观又能彻底破坏文字
        const blockSize = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) / 80));
        // 覆盖边距：收紧到 4px，避免 OCR 框略偏时盖住附近的人脸/无关区域
        const padding = 4;

        for (const item of piiItems) {
            // 优先用精确 word bbox，不用整行 rowBbox——避免整行框过大盖住附近人脸
            const box = item.bbox || item.rowBbox;
            if (!box) continue;
            const x0 = Number(box.x0) || 0;
            const y0 = Number(box.y0) || 0;
            const x1 = Number(box.x1) || x0;
            const y1 = Number(box.y1) || y0;
            const rx = Math.max(0, x0 - padding);
            const ry = Math.max(0, y0 - padding);
            const rw = Math.min(canvas.width - rx, x1 - x0 + padding * 2);
            const rh = Math.min(canvas.height - ry, y1 - y0 + padding * 2);
            if (rw > 0 && rh > 0) {
                mosaicCover(ctx, rx, ry, rw, rh, blockSize);
            }
        }
        console.log(`[图片清洗] 已用马赛克对 ${piiItems.length} 处个人信息打码`);
    }

    // 全图文字打码：覆盖所有 OCR 识别到的文字区域（路标、招牌等）
    if (allTextItems && allTextItems.length > 0) {
        const blockSize = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) / 70));
        const padding = 6;
        const alreadyMasked = [];
        if (piiItems && piiItems.length > 0) {
            for (const item of piiItems) {
                const box = item.rowBbox || item.bbox; if (!box) continue;
                alreadyMasked.push({ x0: Number(box.x0)||0, y0: Number(box.y0)||0, x1: Number(box.x1)||0, y1: Number(box.y1)||0 });
            }
        }
        function rectsOverlap(a, b) { return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0); }
        let maskedCount = 0;
        for (const item of allTextItems) {
            const box = item.rowBbox || item.bbox; if (!box) continue;
            const x0 = Number(box.x0)||0, y0 = Number(box.y0)||0, x1 = Number(box.x1)||x0, y1 = Number(box.y1)||y0;
            const rx = Math.max(0, x0 - padding), ry = Math.max(0, y0 - padding);
            const rw = Math.min(canvas.width - rx, x1 - x0 + padding * 2);
            const rh = Math.min(canvas.height - ry, y1 - y0 + padding * 2);
            if (rw <= 0 || rh <= 0) continue;
            const newRect = { x0: rx, y0: ry, x1: rx + rw, y1: ry + rh };
            let overlap = false;
            // 只与 PII 已打码区域去重；相邻文字框之间允许重叠，否则框体相交的
            // 相邻文字（如 "ENEROC" 与 "C鹏成科技"）会因互相重叠而被漏打
            for (const am of alreadyMasked) { if (rectsOverlap(newRect, am)) { overlap = true; break; } }
            if (!overlap) { mosaicCover(ctx, rx, ry, rw, rh, blockSize); maskedCount++; }
        }
        console.log(`[图片清洗] 已额外对 ${maskedCount} 处全图文字打码`);
    }

    // 导出为 JPEG（质量 0.92），JPEG 导出天然不带 EXIF
    // 如果原图是 PNG 就导出 PNG（保持透明背景）
    const isPng = file.type === "image/png";
    const mimeType = isPng ? "image/png" : "image/jpeg";
    const quality = isPng ? undefined : 0.92;

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("Canvas 导出失败"));
        }, mimeType, quality);
    });

    return blob;
}

// ============================================================
// 3. PDF 深度清洗：重渲染脱敏
// ============================================================

/**
 * PDF 深度清洗 —— 把每一页渲染成图片，再用 pdf-lib 拼成新的 PDF。
 *
 * 为什么这么做（为什么能解决"蓝底/红底同色文字删不掉"）：
 *   - 隐藏文字（无论白底白字、红底红字、蓝底蓝字……）和背景同色，
 *     渲染成图片时天然不可见 → 直接消失；
 *   - 黑框遮挡的文字在黑框下面，重渲染后文字层被移除，复制粘贴也拿不到；
 *   - pdf.js 的 render() 默认不画批注 → 批注对象一并被移除；
 *   - 整页变成图片 → 没有文字层，任何内容都不可复制提取。
 * 结论：不依赖背景颜色，任意颜色都能真正清干净。
 *
 * @param {File} file - PDF 文件
 * @returns {Promise<Blob>} - 清洗后的 Blob（图片型 PDF）
 */
async function sanitizePdfRedact(file) {
    if (typeof pdfjsLib === "undefined") throw new Error("pdf.js 未加载，无法深度清洗");
    if (typeof PDFLib === "undefined") throw new Error("pdf-lib 未加载，无法深度清洗");

    const buffer = await Utils.readFileAsArrayBuffer(file);

    // worker 路径：已在别处配置过就不覆盖（浏览器默认用相对路径，Node 测试可预置绝对路径）
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
    }
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdfDoc = await loadingTask.promise;

    const { PDFDocument } = PDFLib;
    const outDoc = await PDFDocument.create();
    const scale = 2; // 2 倍清晰度渲染，保证清洗后文字可读

    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: scale });

        // 渲染这一页到 canvas
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        // 编码成 JPEG
        const jpegBytes = await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) return reject(new Error("页面转图片失败"));
                const fr = new FileReader();
                fr.onload = () => resolve(new Uint8Array(fr.result));
                fr.onerror = () => reject(fr.error);
                fr.readAsArrayBuffer(blob);
            }, "image/jpeg", 0.92);
        });

        // 原页面尺寸（点 pt）
        const w = viewport.width / scale;
        const h = viewport.height / scale;

        const img = await outDoc.embedJpg(jpegBytes);
        const outPage = outDoc.addPage([w, h]);
        outPage.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }

    // 清空元数据（重渲染路径也需要清）
    outDoc.setTitle("");
    outDoc.setAuthor("");
    outDoc.setSubject("");
    outDoc.setCreator("");
    outDoc.setProducer("");
    outDoc.setKeywords([]);
    outDoc.setCreationDate(new Date(0));
    outDoc.setModificationDate(new Date(0));

    const bytes = await outDoc.save();
    return new Blob([bytes], { type: "application/pdf" });
}

// ============================================================
// 4. PDF 元数据清洗
// ============================================================

/**
 * 清洗 PDF 元数据
 * 用 pdf-lib 正规重写元数据（作者、创建工具、标题、主题、关键词等），
 * 而不是用正则/字符串替换（那会改坏文件长度和 xref 偏移）。
 *
 * @param {File} file - PDF 文件
 * @returns {Promise<Blob>} - 清洗后的 Blob
 */
async function sanitizePdfMetadata(file) {
    if (typeof PDFLib === "undefined") throw new Error("pdf-lib 未加载，无法清洗元数据");

    const buffer = await Utils.readFileAsArrayBuffer(file);
    const { PDFDocument } = PDFLib;

    // ignoreEncryption：容忍被加密/带权限控制的文件，能清则清
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false });

    // 清空所有个人信息相关的元数据
    pdfDoc.setTitle("");
    pdfDoc.setAuthor("");
    pdfDoc.setSubject("");
    pdfDoc.setCreator("");
    pdfDoc.setProducer("");
    pdfDoc.setKeywords([]);
    // 清空创建时间和修改时间（覆盖为默认时间）
    pdfDoc.setCreationDate(new Date(0));
    pdfDoc.setModificationDate(new Date(0));
    // 清空 XMP 元数据流（WPS/Adobe 优先读取这个，Info 字典清了也没用）
    try {
        const catalog = pdfDoc.catalog;
        if (catalog && catalog.delete) {
            catalog.delete(pdfDoc.context.obj('Metadata'));
        }
    } catch (e) { console.warn('[PDF 清洗] 清空 XMP 元数据失败:', e.message); }

    // pdf-lib 重写 = 重建 xref 表，同时把"增量保存的旧版本残留"一并清掉
    const bytes = await pdfDoc.save();
    return new Blob([bytes], { type: "application/pdf" });
}

// ============================================================
// 辅助：下载 Blob
// ============================================================

/**
 * 触发浏览器下载一个 Blob
 * @param {Blob} blob - 要下载的文件
 * @param {string} filename - 文件名
 */
function downloadBlob(blob, filename) {
    // 桌面版（Electron）：走原生"另存为"对话框
    if (window.electronAPI && window.electronAPI.saveFile) {
        blob.arrayBuffer().then((buf) => {
            window.electronAPI.saveFile(buf, filename);
        }).catch((err) => {
            console.error("Electron 保存失败:", err);
        });
        return;
    }

    // 浏览器版：创建一个临时的 a 标签
    const a = document.createElement("a");
    // 创建 Blob URL
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    // 加到 DOM 里，触发点击
    document.body.appendChild(a);
    a.click();
    // 清理
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================
// 导出到全局
// ============================================================
window.sanitizeFile = sanitizeFile;
window.sanitizeDocx = sanitizeDocx;
window.sanitizeImage = sanitizeImage;
window.sanitizePdfRedact = sanitizePdfRedact;
window.downloadBlob = downloadBlob;
window.sanitizeXlsx = sanitizeXlsx;

// ============================================================
// 5. Excel(.xlsx/.xlsm) 清洗
// ============================================================
// 说明：批量清洗统一入口在 main.js（handleBatchClean），此处只提供单文件清洗函数。

/**
 * 清洗 Excel 文件：清元数据 + 删批注 + 删隐藏文字/隐藏行列/隐藏表里的单元格
 * @param {File} file - xlsx/xlsm 文件
 * @returns {Promise<Blob>} - 清洗后的 Blob
 *
 * 原理（安全优先，不破坏结构）：
 *   1. 清空 docProps/core.xml、app.xml 的作者/公司/最后修改者；删除 custom.xml
 *   2. 删除批注部件（xl/comments/commentN.xml、vmlDrawing）+ 对应 rels / Content_Types / legacyDrawing 引用
 *   3. 删除"白字/同色隐藏文字"单元格、隐藏行/隐藏列里的单元格、隐藏工作表里的单元格（只删 <c>，不碰结构）
 *   4. 重新打包成 ZIP（即新的 xlsx）
 */
async function sanitizeXlsx(file, options = {}) {
    const opts = {
        cleanMeta: true,
        cleanComments: true,
        cleanHiddenSheets: true,
        cleanHiddenRowsCols: true,
        ...options
    };

    const buffer = await Utils.readFileAsArrayBuffer(file);
    const zip = await JSZip.loadAsync(buffer);

    // ---- 1. 清元数据 ----
    if (opts.cleanMeta) {
        const corePath = "docProps/core.xml";
        if (zip.file(corePath)) {
            let core = await zip.file(corePath).async("string");
            core = core
                .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/g, "<dc:creator></dc:creator>")
                .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/g, "<cp:lastModifiedBy></cp:lastModifiedBy>")
                .replace(/<dc:title>[\s\S]*?<\/dc:title>/g, "<dc:title></dc:title>")
                .replace(/<dc:subject>[\s\S]*?<\/dc:subject>/g, "<dc:subject></dc:subject>")
                .replace(/<cp:category>[\s\S]*?<\/cp:category>/g, "<cp:category></cp:category>")
                .replace(/<cp:keywords>[\s\S]*?<\/cp:keywords>/g, "<cp:keywords></cp:keywords>")
                .replace(/<dcterms:created[^>]*>[\s\S]*?<\/dcterms:created>/g, "<dcterms:created></dcterms:created>")
                .replace(/<dcterms:modified[^>]*>[\s\S]*?<\/dcterms:modified>/g, "<dcterms:modified></dcterms:modified>");
            zip.file(corePath, core);
        }
        const appPath = "docProps/app.xml";
        if (zip.file(appPath)) {
            let app = await zip.file(appPath).async("string");
            app = app.replace(/<Company>[\s\S]*?<\/Company>/g, "<Company></Company>");
            app = app.replace(/<Manager>[\s\S]*?<\/Manager>/g, "<Manager></Manager>");
            zip.file(appPath, app);
        }
        // custom.xml 常存自定义敏感属性，直接删除
        if (zip.file("docProps/custom.xml")) zip.remove("docProps/custom.xml");
    }

    // ---- 2. 删批注（含引用清理，防悬空） ----
    if (opts.cleanComments) {
        const toRemove = [];
        for (const name of Object.keys(zip.files)) {
            if (/^xl\/comments\/comment\d+\.xml$/.test(name)) toRemove.push(name);
            if (/^xl\/comments\/_rels\/.*\.rels$/.test(name)) toRemove.push(name);
            // 批注绘制框：openpyxl 叫 commentsDrawingN.vml，其他工具叫 vmlDrawingN.vml
            if (/^xl\/drawings\/(commentsDrawing|vmlDrawing)\d+\.vml$/.test(name)) toRemove.push(name);
            if (/^xl\/drawings\/_rels\/.*\.rels$/.test(name)) toRemove.push(name);
        }
        // worksheets/_rels/*.rels 里移除指向 comments/vmlDrawing 的关系
        for (const name of Object.keys(zip.files)) {
            if (!/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)) continue;
            let rels = await zip.file(name).async("string");
            rels = rels.replace(/<Relationship[^>]*Target="[^"]*(comments|vmlDrawing)[^"]*"[^>]*\/>/g, "");
            if (/<Relationship\b/.test(rels)) zip.file(name, rels);
            else toRemove.push(name);
        }
        // [Content_Types].xml 移除指向 comments/vmlDrawing 的 Override
        const ctPath = "[Content_Types].xml";
        if (zip.file(ctPath)) {
            let ct = await zip.file(ctPath).async("string");
            ct = ct.replace(/<Override\s+PartName="\/xl\/(comments\/comment\d+\.xml|drawings\/vmlDrawing\d+\.vml)"[^>]*\/>/g, "");
            zip.file(ctPath, ct);
        }
    // 工作表里的 <legacyDrawing>（批注框引用）移除
    for (const name of Object.keys(zip.files)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
        let s = await zip.file(name).async("string");
        s = s.replace(/<legacyDrawing[^>]*\/>/g, "");
        zip.file(name, s);
    }
    for (const name of toRemove) zip.remove(name);
    } // end if (opts.cleanComments)

    // ---- 3. 删隐藏文字 / 隐藏行列 / 隐藏表里的单元格 ----
    // 3.1 解析 styles.xml 颜色映射（与 analyze-xlsx 一致）
    let fonts = [], fills = [], cellXfs = [];
    if (zip.file("xl/styles.xml")) {
        const std = new DOMParser().parseFromString(await zip.file("xl/styles.xml").async("string"), "text/xml");
        const fn = std.getElementsByTagName("font");
        for (let i = 0; i < fn.length; i++) {
            const c = fn[i].getElementsByTagName("color")[0];
            fonts.push(c ? (c.getAttribute("rgb") || "").slice(-6).toUpperCase() : "");
        }
        const fl = std.getElementsByTagName("fill");
        for (let i = 0; i < fl.length; i++) {
            const bg = fl[i].getElementsByTagName("bgColor")[0] || fl[i].getElementsByTagName("fgColor")[0];
            fills.push(bg ? (bg.getAttribute("rgb") || "").slice(-6).toUpperCase() : "");
        }
        const cx = std.getElementsByTagName("cellXfs")[0];
        if (cx) {
            const xfs = cx.getElementsByTagName("xf");
            for (let i = 0; i < xfs.length; i++) {
                cellXfs.push({ fontId: parseInt(xfs[i].getAttribute("fontId"), 10), fillId: parseInt(xfs[i].getAttribute("fillId"), 10) });
            }
        }
    }

    // 3.2 隐藏工作表名单（state=hidden/veryHidden）
    const hiddenSheets = new Set();
    if (zip.file("xl/workbook.xml")) {
        const wd = new DOMParser().parseFromString(await zip.file("xl/workbook.xml").async("string"), "text/xml");
        const sh = wd.getElementsByTagName("sheet");
        for (let i = 0; i < sh.length; i++) {
            const st = sh[i].getAttribute("state") || "visible";
            if (st === "hidden" || st === "veryHidden") {
                // 记录其 r:id → 需要 sheet 编号；此处按索引收集
                hiddenSheets.add(sh[i].getAttribute("name"));
            }
        }
    }
    // 通过 workbook rels 把隐藏表名 → sheetN（为简化，清洗时按"隐藏表里的单元格全删"处理，
    // 名称匹配到 worksheet 编号）
    let hiddenSheetNums = new Set();
    const sheetNumByName = {};
    if (zip.file("xl/_rels/workbook.xml.rels")) {
        const rd = new DOMParser().parseFromString(await zip.file("xl/_rels/workbook.xml.rels").async("string"), "text/xml");
        const rels = rd.getElementsByTagName("Relationship");
        for (let i = 0; i < rels.length; i++) {
            const t = rels[i].getAttribute("Target") || "";
            const m = t.match(/worksheets\/sheet(\d+)\.xml$/);
            if (m) {
                // workbook.xml 里 sheet 的 r:id 顺序关联名称
                const rid = rels[i].getAttribute("Id");
                sheetNumByName[rid] = parseInt(m[1], 10);
            }
        }
        const wbXml = await zip.file("xl/workbook.xml").async("string");
        const wd = new DOMParser().parseFromString(wbXml, "text/xml");
        const sh = wd.getElementsByTagName("sheet");
        for (let i = 0; i < sh.length; i++) {
            const rid = sh[i].getAttribute("r:id");
            const st = sh[i].getAttribute("state") || "visible";
            if ((st === "hidden" || st === "veryHidden") && rid && sheetNumByName[rid]) {
                hiddenSheetNums.add(sheetNumByName[rid]);
            }
        }
    }

    // 3.3 整表删除隐藏工作表：删 sheetN.xml + rels + workbook.xml 里的 sheet 节点
    if (opts.cleanHiddenSheets) {
        for (const n of hiddenSheetNums) {
            // 删 sheet xml 文件
            zip.remove(`xl/worksheets/sheet${n}.xml`);
            // 删对应的 rels 文件
            zip.remove(`xl/worksheets/_rels/sheet${n}.xml.rels`);
            console.log(`[Excel 清洗] 整表删除隐藏工作表 sheet${n}`);
        }
        // 从 workbook.xml 里删掉对应的 <sheet> 节点
        if (hiddenSheetNums.size > 0 && zip.file("xl/workbook.xml")) {
            let wbContent = await zip.file("xl/workbook.xml").async("string");
            const wbDoc = new DOMParser().parseFromString(wbContent, "text/xml");
            const sheets = wbDoc.getElementsByTagName("sheet");
            const sheetsToRemove = [];
            for (let i = 0; i < sheets.length; i++) {
                const rid = sheets[i].getAttribute("r:id");
                if (rid && sheetNumByName[rid] && hiddenSheetNums.has(sheetNumByName[rid])) {
                    sheetsToRemove.push(sheets[i]);
                }
            }
            for (const s of sheetsToRemove) {
                s.parentNode.removeChild(s);
            }
            const serializer = new XMLSerializer();
            zip.file("xl/workbook.xml", serializer.serializeToString(wbDoc));
        }
    }

    // 3.4 遍历每个工作表，删除隐藏行列里的单元格
    const MAX_SHEETS = 50;
    if (opts.cleanHiddenRowsCols) {
    for (let n = 1; n <= MAX_SHEETS; n++) {
        const p = `xl/worksheets/sheet${n}.xml`;
        if (!zip.file(p)) continue;
        const doc = new DOMParser().parseFromString(await zip.file(p).async("string"), "text/xml");
        const rows = doc.getElementsByTagName("row");
        // 收集隐藏列区间
        const hiddenColRanges = [];
        const cols = doc.getElementsByTagName("col");
        for (let i = 0; i < cols.length; i++) {
            if (cols[i].getAttribute("hidden") === "1" || cols[i].getAttribute("hidden") === "true") {
                hiddenColRanges.push({
                    min: parseInt(cols[i].getAttribute("min"), 10) || 0,
                    max: parseInt(cols[i].getAttribute("max"), 10) || 0,
                });
            }
        }
        const colIndex = (ref) => { // "A"→1,"C"→3
            const m = ref.match(/^([A-Z]+)/);
            if (!m) return 0;
            let v = 0;
            for (let i = 0; i < m[1].length; i++) v = v * 26 + (m[1].charCodeAt(i) - 64);
            return v;
        };
        const inHiddenCol = (ref) => {
            const ci = colIndex(ref);
            return hiddenColRanges.some(r => ci >= r.min && ci <= r.max);
        };

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowHidden = row.getAttribute("hidden") === "1" || row.getAttribute("hidden") === "true";
            const isHiddenSheet = hiddenSheetNums.has(n);
            const cells = row.getElementsByTagName("c");
            const toDel = [];
            for (let j = 0; j < cells.length; j++) {
                const cell = cells[j];
                const ref = cell.getAttribute("r") || "";
                const styleIdx = parseInt(cell.getAttribute("s"), 10);
                let fontColor = "", fillColor = "";
                if (!isNaN(styleIdx) && cellXfs[styleIdx]) {
                    const xf = cellXfs[styleIdx];
                    if (!isNaN(xf.fontId) && fonts[xf.fontId]) fontColor = fonts[xf.fontId];
                    if (!isNaN(xf.fillId) && fills[xf.fillId]) fillColor = fills[xf.fillId];
                }
                const isWhite = fontColor === "FFFFFF";
                const isSame = fontColor && fillColor && fontColor === fillColor;
                if (isHiddenSheet || rowHidden || inHiddenCol(ref) || isWhite || isSame) {
                    toDel.push(cell);
                }
            }
            toDel.forEach(c => c.parentNode.removeChild(c));
        }
        zip.file(p, new XMLSerializer().serializeToString(doc));
    }
    } // end if (opts.cleanHiddenRowsCols)

    // ---- 重新打包 ----
    return zip.generateAsync({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
}



/**
 * 清洗 PPTX 文件：删隐藏幻灯片节点 + 删批注 + 清元数据
 * 隐藏幻灯片：直接从 presentation.xml 删 sldId 节点，不是取消隐藏
 */
async function sanitizePptx(file, options = {}) {
    const opts = {
        cleanMeta: true,
        cleanComments: true,
        cleanHiddenSlides: true,
        cleanNotes: true,
        ...options
    };
    const buffer = await Utils.readFileAsArrayBuffer(file);
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files);

    // ---- 1. 删隐藏幻灯片：改 presentation.xml + 删对应 slide 文件 ----
    if (opts.cleanHiddenSlides && files.includes('ppt/presentation.xml')) {
        const presXml = await zip.file('ppt/presentation.xml').async('string');
        // 抓所有 sldId 节点，逐个判断是否 show="0"（属性顺序不限）
        const sldIdRegex = /<p:sldId\b[^>]*\/>/g;
        const allSldIds = presXml.match(sldIdRegex) || [];
        const hiddenRIds = [];
        for (const node of allSldIds) {
            if (/show="0"/.test(node)) {
                const ridMatch = node.match(/r:id="([^"]+)"/);
                if (ridMatch) hiddenRIds.push(ridMatch[1]);
            }
        }
        // 从 presentation.xml.rels 找 r:id 对应的 slide 文件路径
        let relsXml = '';
        if (zip.file('ppt/_rels/presentation.xml.rels')) {
            relsXml = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
        }
        const slideFilesToRemove = [];
        for (const rid of hiddenRIds) {
            const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"[^>]*\/>`));
            if (relMatch) {
                let target = relMatch[1];
                if (!target.startsWith('ppt/')) target = 'ppt/' + target.replace('../', '');
                slideFilesToRemove.push(target);
            }
        }
        // 删 slide 文件 + rels
        for (const sf of slideFilesToRemove) {
            if (zip.file(sf)) zip.remove(sf);
            const sfRels = sf.replace('slides/', 'slides/_rels/') + '.rels';
            if (zip.file(sfRels)) zip.remove(sfRels);
        }
        // 从 presentation.xml 删所有隐藏 sldId 节点
        let cleanedXml = presXml;
        for (const node of allSldIds) {
            if (/show="0"/.test(node)) {
                cleanedXml = cleanedXml.replace(node, '');
            }
        }
        zip.file('ppt/presentation.xml', cleanedXml);
        console.log(`[PPT 清洗] 已删除 ${hiddenRIds.length} 个隐藏幻灯片（含文件本体）`);
    }

    // ---- 2. 删批注 ----
    if (opts.cleanComments) {
        const commentFiles = files.filter(f => f.includes('comments/'));
        for (const cf of commentFiles) {
            zip.remove(cf);
        }
        if (commentFiles.length > 0) {
            console.log(`[PPT 清洗] 已删除 ${commentFiles.length} 个批注文件`);
        }
    }

    // ---- 3. 清空演讲者备注：删除 notesSlideN.xml ----
    if (opts.cleanNotes) {
        const noteFiles = files.filter(f => f.includes('notesSlides/notesSlide') && f.endsWith('.xml'));
        for (const nf of noteFiles) {
            zip.remove(nf);
        }
        if (noteFiles.length > 0) {
            console.log(`[PPT 清洗] 已清空 ${noteFiles.length} 页演讲者备注`);
        }
    }

    // ---- 4. 清元数据：改 docProps/core.xml + app.xml ----
    if (opts.cleanMeta && files.includes('docProps/core.xml')) {
        const coreXml = await zip.file('docProps/core.xml').async('string');
        const cleanedCore = coreXml
            .replace(/<dc:creator>[^<]*<\/dc:creator>/g, '<dc:creator></dc:creator>')
            .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, '<cp:lastModifiedBy></cp:lastModifiedBy>')
            .replace(/<dc:title>[^<]*<\/dc:title>/g, '<dc:title></dc:title>')
            .replace(/<dc:subject>[^<]*<\/dc:subject>/g, '<dc:subject></dc:subject>')
            .replace(/<cp:keywords>[^<]*<\/cp:keywords>/g, '<cp:keywords></cp:keywords>')
            .replace(/<cp:category>[^<]*<\/cp:category>/g, '<cp:category></cp:category>')
            .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, '<dcterms:created></dcterms:created>')
            .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, '<dcterms:modified></dcterms:modified>');
        zip.file('docProps/core.xml', cleanedCore);
        console.log('[PPT 清洗] 已清除 core.xml 元数据');
    }
    if (opts.cleanMeta && files.includes('docProps/app.xml')) {
        const appXml = await zip.file('docProps/app.xml').async('string');
        const cleanedApp = appXml
            .replace(/<Company>[^<]*<\/Company>/g, '<Company></Company>')
            .replace(/<Manager>[^<]*<\/Manager>/g, '<Manager></Manager>');
        zip.file('docProps/app.xml', cleanedApp);
        console.log('[PPT 清洗] 已清除 app.xml 公司/经理');
    }

    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
