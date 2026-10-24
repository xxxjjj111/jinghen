/**
 * analyze-pdf.js — PDF 文件分析模块
 *
 * 主要检测项：
 *   1. 元数据泄露（作者、标题、创建工具等）
 *   2. 增量保存检测（PDF 被修改后"另存为"会保留旧版本，删的东西还在）
 *   3. 假黑框检测（用黑色矩形盖住文字，但文字层还在，复制粘贴就能拿到）
 *   4. 批注/注释检测（PDF 里的文字批注、高亮批注等，类似 Word 批注）
 *
 * 依赖：pdf.js（全局变量为 pdfjsLib）
 *
 * 返回格式：
 * {
 *   metadata: { ... },
 *   incremental: { hasIncremental, versionCount, ... },
 *   fakeRedaction: { hasFakeRedaction, count, items: [...] },
 *   annotations: { hasAnnotations, count, items: [...] },
 *   error: null 或 错误信息
 * }
 */

/**
 * 分析一个 PDF 文件
 * @param {File|ArrayBuffer} fileInput - 文件
 * @returns {Promise<Object>} - 检测结果
 *
 * 使用方式：
 *   const result = await analyzePdf(file);
 *   console.log(result.incremental.versionCount);  // 版本数
 *   console.log(result.fakeRedaction.hasFakeRedaction);  // 是否有假黑框
 */
async function analyzePdf(fileInput) {
    const result = {
        metadata: null,       // 元数据
        incremental: null,    // 增量保存检测
        fakeRedaction: null,  // 假黑框检测
        annotations: null,    // 批注/注释检测
        error: null,
    };

    // DoS 防护：PDF 最大解析页数
    const MAX_PAGES = 200;
    // DoS 防护：每页最多分析多少段文字（防止海量文字占满内存）
    const MAX_TEXT_ITEMS_PER_PAGE = 5000;

    try {
        // 获取 ArrayBuffer
        let buffer;
        if (fileInput instanceof File) {
            buffer = await Utils.withTimeout(
                Utils.readFileAsArrayBuffer(fileInput),
                Utils.PARSE_TIMEOUTS.pdf,
                "PDF 文件读取超时"
            );
        } else {
            buffer = fileInput;
        }

        // 配置 pdf.js 的 worker 文件路径
        // worker 是 pdf.js 用来后台解析 PDF 的，必须指向本地文件
        // （lib 文件夹里的 pdf.worker.min.js）
        if (typeof pdfjsLib !== "undefined") {
            pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
        }

        // 用 pdf.js 加载 PDF（带超时）
        const loadingTask = pdfjsLib.getDocument({
            data: buffer,
        });
        const pdfDoc = await Utils.withTimeout(
            loadingTask.promise,
            Utils.PARSE_TIMEOUTS.pdf,
            "PDF 解析超时，可能是畸形文件"
        );

        // DoS 防护：页数过多直接报错
        if (pdfDoc.numPages > MAX_PAGES) {
            throw new Error(`PDF 页数过多（${pdfDoc.numPages} 页），最多支持 ${MAX_PAGES} 页`);
        }

        // 1. 提取元数据
        result.metadata = await extractPdfMetadata(pdfDoc);

        // 2. 增量保存检测（扫描原始二进制，找多个 %%EOF 标记）
        result.incremental = detectIncrementalSave(buffer);

        // 3. 隐形文字检测（深色覆盖 + 同色隐藏）
        result.fakeRedaction = await detectFakeRedaction(pdfDoc, MAX_TEXT_ITEMS_PER_PAGE);

        // 4. 批注/注释检测（PDF 里的文字批注、高亮批注等）
        result.annotations = await extractPdfAnnotations(pdfDoc);

    } catch (err) {
        result.error = err.message || "PDF 解析失败";
    }

    return result;
}

// ============================================================
// 1. PDF 元数据提取
// ============================================================

/**
 * 提取 PDF 元数据
 * @param {PDFDocumentProxy} pdfDoc - pdf.js 的文档对象
 * @returns {Promise<Object>}
 */
async function extractPdfMetadata(pdfDoc) {
    const meta = {
        author: "",
        title: "",
        subject: "",
        creator: "",        // 创建工具（如 Word、LaTeX）
        producer: "",       // PDF 生成库（如 Adobe PDF Library）
        creationDate: "",   // 创建时间
        modDate: "",        // 修改时间
        hasSensitive: false,
    };

    try {
        // pdf.js 的 getMetadata() 返回 { info, metadata }
        const metaData = await pdfDoc.getMetadata();
        const info = metaData.info || {};

        meta.author = info.Author || "";
        meta.title = info.Title || "";
        meta.subject = info.Subject || "";
        meta.creator = info.Creator || "";
        meta.producer = info.Producer || "";
        meta.creationDate = info.CreationDate || "";
        meta.modDate = info.ModDate || "";

        // 判断是否有敏感信息
        // 作者、创建工具、PDF 生成器 都属于可能泄露信息的元数据
        meta.hasSensitive = !!(meta.author || meta.creator || meta.producer);

    } catch (err) {
        // 元数据读取失败不影响
    }

    return meta;
}

// ============================================================
// 2. 增量保存检测
// ============================================================

/**
 * 检测 PDF 是否有增量保存（多个历史版本）
 * 通过扫描二进制数据中的 %%EOF 标记数量来判断
 * 每次增量保存都会在文件末尾追加新内容并加一个 %%EOF
 *
 * @param {ArrayBuffer} buffer - PDF 二进制数据
 * @returns {Object} - 检测结果
 */
function detectIncrementalSave(buffer) {
    const result = {
        hasIncremental: false,  // 是否有增量保存
        versionCount: 1,        // 版本数（至少 1 个）
        eofCount: 0,            // %%EOF 出现次数
        prevCount: 0,           // /Prev 指针数量
        estimatedResidueSize: 0,// 估计残留体积（字节）
    };

    try {
        // 把 ArrayBuffer 转成 Uint8Array 方便操作
        const bytes = new Uint8Array(buffer);
        // 目标字符串：%%EOF 和 /Prev
        const eofMarker = "%%EOF";
        const prevMarker = "/Prev";

        // 统计 %%EOF 出现次数
        // 遍历字节数组，找 %%EOF 的位置
        for (let i = 0; i < bytes.length - eofMarker.length; i++) {
            // 简单的字符串匹配（只查可打印 ASCII，性能足够）
            let match = true;
            for (let j = 0; j < eofMarker.length; j++) {
                if (bytes[i + j] !== eofMarker.charCodeAt(j)) {
                    match = false;
                    break;
                }
            }
            if (match) {
                result.eofCount++;
            }
        }

        // 统计 /Prev 出现次数
        for (let i = 0; i < bytes.length - prevMarker.length; i++) {
            let match = true;
            for (let j = 0; j < prevMarker.length; j++) {
                if (bytes[i + j] !== prevMarker.charCodeAt(j)) {
                    match = false;
                    break;
                }
            }
            if (match) {
                result.prevCount++;
            }
        }

        // 版本数 = %%EOF 的数量
        result.versionCount = Math.max(1, result.eofCount);

        // 如果有多个 %%EOF，说明有增量保存
        if (result.eofCount > 1) {
            result.hasIncremental = true;
            // 估算残留体积：总大小除以版本数再乘（版本数-1）
            result.estimatedResidueSize = Math.round(
                (bytes.length / result.versionCount) * (result.versionCount - 1)
            );
        }

    } catch (err) {
        // 检测失败保持默认值
    }

    return result;
}

// ============================================================
// 3. 假黑框检测（像素级对比法）
// ============================================================

/**
 * 检测 PDF 中的假黑框（黑色矩形覆盖文字，但文字层还在）
 *
 * 原理（像素级对比法，更准确）：
 *   1. 把 PDF 页面渲染成一张图片（canvas）
 *   2. 获取文字层所有文字的位置和内容
 *   3. 对每一段文字，检查它所在位置的像素颜色
 *   4. 如果文字位置的像素是深色的（被盖住了），但文字层里还有文字
 *      → 说明是"假遮挡"：视觉上看不到，但复制粘贴还能拿到
 *
 * 这个方法比"找黑色矩形"更靠谱，因为不关心黑框是怎么画的，
 * 只看最终的视觉效果。
 *
 * @param {PDFDocumentProxy} pdfDoc - pdf.js 文档对象
 * @returns {Promise<Object>}
 */
async function detectFakeRedaction(pdfDoc, maxTextItemsPerPage = 5000) {
    const result = {
        hasFakeRedaction: false,  // 是否有假黑框
        count: 0,                 // 假遮挡区域数量
        items: [],                // 详细列表（每页的情况）
    };

    try {
        const totalPages = pdfDoc.numPages;  // 总页数

        // 逐页检查（最多查前 20 页，避免太慢）
        const pagesToCheck = Math.min(totalPages, 20);

        for (let pageNum = 1; pageNum <= pagesToCheck; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);

            // 获取文字内容（带坐标）
            const textContent = await page.getTextContent();
            const textItems = textContent.items;

            // 如果页面没有文字，直接跳过
            if (textItems.length === 0) continue;

            // DoS 防护：每页文字段数过多时只取前 N 段
            const itemsToCheck = textItems.slice(0, maxTextItemsPerPage);

            // ---- 第一步：把页面渲染到 canvas 上 ----
            // 设置渲染比例（2 倍清晰度，像素检测更准确）
            const scale = 2;
            // viewport 是页面的可视区域（尺寸）
            const viewport = page.getViewport({ scale: scale });

            // 创建一个 canvas 元素（不在页面上显示，只是用来拿像素数据）
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");  // 获取 2D 绘图上下文
            canvas.width = viewport.width;       // canvas 宽度 = 页面宽度 × scale
            canvas.height = viewport.height;     // canvas 高度 = 页面高度 × scale

            // 用 pdf.js 把页面渲染到 canvas 上
            await page.render({
                canvasContext: ctx,
                viewport: viewport,
            }).promise;

            // ---- 第二步：获取整个页面的像素数据 ----
            // getImageData(x, y, w, h) — 获取指定区域的像素数据
            // 返回的 data 是一个数组，每 4 个元素代表一个像素（RGBA）
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;  // 像素数组 [r,g,b,a, r,g,b,a, ...]

            // ---- 第三步：逐段文字检查是不是"看不见的" ----
            // 两种情况算"看不见"：
            //   A. 文字区域大部分是深色 → 被黑框/深色图形盖住了
            //   B. 文字颜色和背景颜色几乎一样 → 同色隐藏（白字白底/黑字黑底）
            const coveredTexts = [];  // 存放被遮挡/隐藏的文字

            for (const item of itemsToCheck) {
                // 跳过空文字
                if (!item.str || item.str.trim().length === 0) continue;

                // 文字的位置和尺寸（PDF 坐标，要乘以 scale 变成 canvas 像素坐标）
                // transform[4] = x, transform[5] = y（PDF 坐标原点在左下角）
                const textX = item.transform[4] * scale;      // 文字 x 坐标（像素）
                const textY = item.transform[5] * scale;      // 文字 y 坐标（像素）
                const textW = item.width * scale;             // 文字宽度（像素）
                const textH = (item.height || 12) * scale;    // 文字高度（像素，默认12）

                // 注意：PDF 坐标原点在左下角，canvas 原点在左上角
                // 所以 y 坐标要转换一下：canvasY = canvas高度 - pdfY - 文字高度
                const canvasY = canvas.height - textY - textH;

                // ---- 第一步：取背景色（从文字左右两侧的空白区域取） ----
                // 为什么从左右两侧取？
                //   上方可能被黑框覆盖，下方可能有下一行文字
                //   左右两侧通常是空白背景，最可靠
                let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
                const sideOffset = 20;  // 距离文字左右各 20 像素
                const bgSampleCount = 5; // 取 5 个采样点

                for (let i = 0; i < bgSampleCount; i++) {
                    // 文字中间高度的位置
                    const sampleY = Math.floor(canvasY + textH * (0.3 + i * 0.1));  // 30%-70% 范围
                    // 左侧采样点
                    const leftX = Math.floor(textX - sideOffset);
                    // 右侧采样点
                    const rightX = Math.floor(textX + textW + sideOffset);

                    // 左侧采样
                    if (leftX >= 0 && sampleY >= 0 && sampleY < canvas.height) {
                        const idx = (sampleY * canvas.width + leftX) * 4;
                        bgR += pixels[idx];
                        bgG += pixels[idx + 1];
                        bgB += pixels[idx + 2];
                        bgCount++;
                    }
                    // 右侧采样
                    if (rightX < canvas.width && sampleY >= 0 && sampleY < canvas.height) {
                        const idx = (sampleY * canvas.width + rightX) * 4;
                        bgR += pixels[idx];
                        bgG += pixels[idx + 1];
                        bgB += pixels[idx + 2];
                        bgCount++;
                    }
                }
                // 计算平均背景色
                if (bgCount > 0) {
                    bgR = Math.round(bgR / bgCount);
                    bgG = Math.round(bgG / bgCount);
                    bgB = Math.round(bgB / bgCount);
                } else {
                    bgR = 255; bgG = 255; bgB = 255;  // 取不到就默认白色
                }

                // ---- 第二步：取文字区域内多行像素 ----
                let darkPixelCount = 0;     // 深色像素计数
                let lightPixelCount = 0;    // 浅色像素计数
                let totalSampleCount = 0;   // 总采样数
                let sumR = 0, sumG = 0, sumB = 0;  // 文字区域颜色总和

                const sampleLines = [0.2, 0.35, 0.5, 0.65, 0.8];  // 5 行采样
                const step = 3;  // 每隔 3 个像素取一个样

                for (const lineRatio of sampleLines) {
                    const sampleY = Math.floor(canvasY + textH * lineRatio);

                    for (let px = Math.floor(textX); px < textX + textW; px += step) {
                        if (px < 0 || px >= canvas.width) continue;
                        if (sampleY < 0 || sampleY >= canvas.height) continue;

                        const pixelIndex = (sampleY * canvas.width + Math.floor(px)) * 4;
                        const r = pixels[pixelIndex];
                        const g = pixels[pixelIndex + 1];
                        const b = pixels[pixelIndex + 2];

                        const brightness = (r + g + b) / 3;

                        if (brightness < 70) darkPixelCount++;
                        if (brightness > 200) lightPixelCount++;
                        sumR += r;
                        sumG += g;
                        sumB += b;
                        totalSampleCount++;
                    }
                }

                // 采样太少就跳过
                if (totalSampleCount <= 3) continue;

                // 文字区域平均颜色
                const avgR = Math.round(sumR / totalSampleCount);
                const avgG = Math.round(sumG / totalSampleCount);
                const avgB = Math.round(sumB / totalSampleCount);

                // 计算文字区域和背景色的色差（欧氏距离）
                // 色差越小，说明文字和背景越接近，越可能是隐藏的
                const colorDiff = Math.sqrt(
                    Math.pow(avgR - bgR, 2) +
                    Math.pow(avgG - bgG, 2) +
                    Math.pow(avgB - bgB, 2)
                );

                // ---- 第三步：判断是不是"看不见的文字" ----
                // 三种独立的判断方式，只要满足一种就算隐藏
                let isInvisible = false;
                let reason = "";
                const darkRatio = darkPixelCount / totalSampleCount;   // 深色占比
                const lightRatio = lightPixelCount / totalSampleCount; // 浅色占比

                // 同色隐藏（方式 2、3）要求"有意义的文字"：
                // 过滤掉 "1."、"。" 这种标点/碎片（采样时大多是背景色，极易误判成 same_color）。
                // 真隐藏内容几乎都是短语/长串（如"密码998877"、"admin_root"），不受影响。
                const meaningfulChars = item.str.replace(/[\s\p{P}\p{S}]/gu, "").length;
                const hasMeaningfulText = meaningfulChars >= 2;

                // 方式 1：深色覆盖（黑框遮挡）
                // 文字区域超过一半是深色的 → 被黑框/深色图形盖住了
                if (darkRatio > 0.5) {
                    isInvisible = true;
                    reason = "dark_cover";
                }

                // 方式 2：浅色覆盖（白字白底 / 浅底浅字）
                // 文字区域 95% 以上都是浅色的 → 文字和白色背景融为一体
                // （这个方法不需要背景色取样，对白色背景最准确）
                if (lightRatio > 0.95 && hasMeaningfulText) {
                    isInvisible = true;
                    reason = "same_color";
                }

                // 方式 3：同色隐藏（任意颜色背景 + 同色文字）
                // 文字区域平均色和背景色的色差 < 25 → 文字颜色和背景几乎一样
                // （用来检测蓝底蓝字、红底红字等非白色背景的隐藏）
                // 注意：只有深色占比不高时才用这个判断，避免和"黑框遮挡"重复
                if (colorDiff < 25 && darkRatio < 0.5 && lightRatio < 0.95 && hasMeaningfulText) {
                    isInvisible = true;
                    reason = "same_color";
                }

                if (isInvisible) {
                    coveredTexts.push({
                        text: item.str,
                        x: item.transform[4],
                        y: item.transform[5],
                        width: item.width,
                        reason: reason,  // 隐藏类型：dark_cover 深色覆盖 / same_color 同色隐藏
                    });
                }
            }

            // ---- 第四步：把相邻的被遮挡文字合并成"遮挡区域" ----
            // （不然一个字算一个，数量太多了）
            const fakeRegions = mergeCoveredTexts(coveredTexts);

            if (fakeRegions.length > 0) {
                result.items.push({
                    page: pageNum,
                    count: fakeRegions.length,
                    details: fakeRegions,
                });
                result.count += fakeRegions.length;
            }

            // 打印统计信息
            console.log(`[PDF检测] 第${pageNum}页：文字${textItems.length}段（检测${itemsToCheck.length}段），隐藏${coveredTexts.length}段，区域${fakeRegions.length}个`);
        }

        result.hasFakeRedaction = result.count > 0;

    } catch (err) {
        // 检测失败不报错，保持默认值
        console.warn("[PDF检测] 假遮挡检测出错：", err);
    }

    return result;
}

// ============================================================
// 4. 批注/注释检测
// ============================================================

/**
 * 检测 PDF 里的批注/注释（类似 Word 批注，是敏感信息残留源）
 *
 * 原理：用 pdf.js 的 page.getAnnotations() 读取页面上的注释对象。
 * 在 pdf.js 3.x 里，作者存在 titleObj.str，正文存在 contentsObj.str。
 * 常见的敏感注释类型：Text（文字批注）、Highlight（高亮批注）、
 * FreeText（自由文本）、Underline/Squiggly/StrikeOut/Stamp 等。
 * 导航类（Link）、表单控件（Widget）、弹窗（Popup）不算泄露，跳过。
 *
 * @param {PDFDocumentProxy} pdfDoc - pdf.js 文档对象
 * @returns {Promise<Object>}
 */
async function extractPdfAnnotations(pdfDoc) {
    const result = {
        hasAnnotations: false,
        count: 0,
        items: [],
    };

    // DoS 防护：最多提取多少条批注
    const MAX_ANNOTATIONS = 2000;

    try {
        // 这些类型是"评论/批注类"，才是需要关注的敏感残留
        const COMMENT_TYPES = ["Text", "FreeText", "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Ink", "Polygon", "PolyLine", "Caret"];
        // 导航/表单/弹窗类忽略
        const SKIP_TYPES = ["Link", "Widget", "Popup"];

        for (let p = 1; p <= pdfDoc.numPages; p++) {
            const page = await pdfDoc.getPage(p);
            let annots = [];
            try {
                annots = await page.getAnnotations();
            } catch (e) {
                continue; // 单页注释读取失败不影响整体
            }

            for (const a of annots || []) {
                // DoS 防护：达到上限就停止
                if (result.items.length >= MAX_ANNOTATIONS) break;

                const subtype = a.subtype || "";
                if (SKIP_TYPES.includes(subtype)) continue;
                if (!COMMENT_TYPES.includes(subtype)) continue;

                // pdf.js 3.x：作者 titleObj.str，正文 contentsObj.str
                const author = (a.titleObj && a.titleObj.str) || "";
                const content = (a.contentsObj && a.contentsObj.str) || "";
                const name = a.name || "";

                // 至少要有一条实质内容才算有效批注
                if (!author && !content) continue;

                result.items.push({
                    page: p,
                    type: subtype,
                    author: Utils.truncate(author, 200),
                    content: Utils.truncate(content || name, 500),
                });
            }

            if (result.items.length >= MAX_ANNOTATIONS) break;
        }

        result.count = result.items.length;
        result.hasAnnotations = result.count > 0;

    } catch (err) {
        console.warn("[PDF检测] 批注检测出错：", err);
    }

    return result;
}

/**
 * 把相邻的被遮挡文字合并成更大的遮挡区域
 * （避免一个字算一条，看起来更清晰）
 * @param {Array} coveredTexts - 被遮挡的文字项数组
 * @returns {Array} - 合并后的遮挡区域数组
 */
function mergeCoveredTexts(coveredTexts) {
    if (coveredTexts.length === 0) return [];

    const regions = [];  // 合并后的区域
    let currentRegion = null;

    // 按 y 坐标排序（从上到下）
    const sorted = coveredTexts.sort((a, b) => b.y - a.y);

    for (const item of sorted) {
        // 如果当前没有区域，或者和当前区域不在同一行（y 差太大），新建一个区域
        // 同时也要判断 reason 是否一样（不同类型不合并）
        if (!currentRegion || Math.abs(item.y - currentRegion.y) > 15 || item.reason !== currentRegion.reason) {
            if (currentRegion) {
                regions.push(currentRegion);  // 把上一行的区域存起来
            }
            // 新建一个区域
            currentRegion = {
                text: item.text,
                x: item.x,
                y: item.y,
                width: item.width,
                textCount: 1,
                reason: item.reason,  // 保存隐藏类型
            };
        } else {
            // 同一行且类型相同，追加到当前区域
            currentRegion.text += item.text;
            currentRegion.width = Math.max(
                currentRegion.width,
                item.x + item.width - currentRegion.x
            );
            currentRegion.textCount++;
        }
    }
    // 别忘了把最后一个区域也加进去
    if (currentRegion) regions.push(currentRegion);

    // 把每个区域的文字截断到 200 字（太长了显示不下）
    // 同时保留 reason 字段（隐藏类型）
    return regions.map(r => ({
        coveredText: r.text.slice(0, 200),
        textCount: r.textCount,
        reason: r.reason,
    }));
}

// ============================================================
// 导出到全局
// ============================================================
window.analyzePdf = analyzePdf;
