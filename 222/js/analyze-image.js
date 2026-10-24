/**
 * analyze-image.js — 图片文件分析模块
 *
 * 主要检测项：
 *   1. EXIF 元数据泄露（相机型号、拍摄时间、GPS 位置等）
 *   2. 缩略图与主图不一致（打码后的照片，缩略图可能还是原图）
 *   3. 图片内容中的个人信息（PII）识别（身份证号、手机号、姓名、地址等）
 *
 * 依赖：exifr（全局变量 exifr）、Tesseract.js（全局变量 Tesseract，用于 OCR）
 *
 * 返回格式：
 * {
 *   exif: { ... },                // EXIF 信息
 *   gps: { lat, lng, hasGps },    // GPS 信息
 *   thumbnail: { ... },           // 缩略图检测结果
 *   pii: { ... },                 // 图片内容中的个人信息检测结果
 *   error: null 或 错误信息
 * }
 */

/**
 * 分析一张图片，返回所有检测结果
 * @param {File|string} fileInput - 文件对象或图片 URL
 * @returns {Promise<Object>} - 检测结果
 *
 * 使用方式：
 *   const result = await analyzeImage(file);
 *   console.log(result.exif.camera);       // 相机型号
 *   console.log(result.gps.hasGps);        // 是否有 GPS
 *   console.log(result.thumbnail.isDiff);  // 缩略图是否不一致
 */
async function analyzeImage(fileInput) {
    const result = {
        exif: null,       // EXIF 元数据
        gps: null,        // GPS 位置信息
        thumbnail: null,  // 缩略图不一致检测结果
        pii: null,        // 图片内容中的个人信息（PII）
        allText: null,    // 图片中识别到的所有文字（全图 OCR 结果，含 bbox）
        error: null,      // 错误信息
    };

    // DoS 防护：图片最大尺寸（像素），防止超大图片占满内存
    const MAX_IMAGE_DIMENSION = 10000;

    try {
        // 获取 ArrayBuffer（exifr 需要二进制数据来解析 EXIF）
        let buffer;
        if (fileInput instanceof File) {
            buffer = await Utils.withTimeout(
                Utils.readFileAsArrayBuffer(fileInput),
                Utils.PARSE_TIMEOUTS.image,
                "图片读取超时"
            );
        } else if (typeof fileInput === "string") {
            // 如果传的是 URL，先 fetch 下来
            const resp = await fetch(fileInput);
            buffer = await resp.arrayBuffer();
        } else {
            buffer = fileInput;
        }

        // 同时解析 EXIF 信息和缩略图（带超时）
        // exifr.parse 可以一次性取出所有元数据
        const exifData = await Utils.withTimeout(
            exifr.parse(buffer, {
                // 让 exifr 返回缩略图的原始数据
                tiff: true,
                xmp: true,
                icc: false,
                iptc: true,
                thumbnail: true, // ← 关键：不开这个，exifr 默认不提取内嵌缩略图
            }),
            Utils.PARSE_TIMEOUTS.image,
            "EXIF 解析超时，可能是畸形图片"
        );

        // 提取 EXIF 基本信息
        result.exif = extractExifInfo(exifData);
        // 提取 GPS 信息
        result.gps = extractGpsInfo(exifData);

        // 检测缩略图与主图是否不一致
        // 需要同时拿到主图和缩略图来比对
        result.thumbnail = await checkThumbnailMismatch(fileInput, buffer, exifData, MAX_IMAGE_DIMENSION);

        // 检测图片内容中的个人信息（PII）
        // 使用 Tesseract.js OCR 识别文字，然后用正则匹配身份证号、手机号等
        result.pii = await detectImagePii(fileInput);

        // 检测图片中的所有可识别文字（用于"全图打码"场景，如路标、建筑名称等）
        result.allText = await detectAllImageText(fileInput);

    } catch (err) {
        result.error = err.message || "图片解析失败";
    }

    return result;
}

// ============================================================
// 1. EXIF 基本信息提取
// ============================================================

/**
 * 从 exifr 返回的数据中提取我们关心的字段
 * @param {Object} exifData - exifr.parse 返回的原始数据
 * @returns {Object} - 整理后的 EXIF 信息
 */
function extractExifInfo(exifData) {
    const info = {
        hasExif: false,          // 是否有 EXIF 信息
        cameraMake: "",          // 相机品牌（如 Apple）
        cameraModel: "",         // 相机型号（如 iPhone 13）
        software: "",            // 处理软件（如 Photoshop）
        dateTimeOriginal: "",    // 拍摄时间
        imageDescription: "",    // 图片描述（可能包含敏感信息）
        artist: "",              // 作者/艺术家
        copyright: "",           // 版权信息
        hasSensitive: false,     // 是否有敏感元数据
    };

    // exifr 把字段平铺在对象里，直接取就行
    if (exifData) {
        // DoS/XSS 防护：所有字符串字段做长度截断
        const MAX_LEN = 200;
        info.cameraMake = Utils.truncate(exifData.Make || exifData.make || "", MAX_LEN);
        info.cameraModel = Utils.truncate(exifData.Model || exifData.model || "", MAX_LEN);
        info.software = Utils.truncate(exifData.Software || exifData.software || "", MAX_LEN);
        info.dateTimeOriginal = Utils.truncate(
            exifData.DateTimeOriginal || exifData.DateTime || exifData.dateTimeOriginal || "",
            MAX_LEN
        );
        info.imageDescription = Utils.truncate(
            exifData.ImageDescription || exifData.imageDescription || "",
            500
        );
        info.artist = Utils.truncate(exifData.Artist || exifData.artist || "", MAX_LEN);
        info.copyright = Utils.truncate(exifData.Copyright || exifData.copyright || "", MAX_LEN);

        // 判断是否有 EXIF（有相机型号或时间就算有）
        info.hasExif = !!(info.cameraModel || info.dateTimeOriginal || info.software);

        // 判断是否有敏感信息（作者、相机型号、描述都算）
        info.hasSensitive = !!(
            info.artist ||
            info.imageDescription ||
            (info.cameraMake && info.cameraModel)
        );
    }

    return info;
}

// ============================================================
// 2. GPS 信息提取
// ============================================================

/**
 * 从 exifr 数据中提取 GPS 位置
 * @param {Object} exifData - exifr.parse 返回的数据
 * @returns {Object} - GPS 信息 { lat, lng, hasGps, formatted }
 */
function extractGpsInfo(exifData) {
    const gps = {
        lat: 0,           // 纬度
        lng: 0,           // 经度
        hasGps: false,    // 是否有 GPS 信息
        formatted: "",    // 格式化后的坐标字符串
    };

    if (exifData && exifData.latitude !== undefined && exifData.longitude !== undefined) {
        // exifr 已经把 GPS 坐标解析成十进制度了，直接用
        gps.lat = exifData.latitude;
        gps.lng = exifData.longitude;
        gps.hasGps = true;
        // 保留 6 位小数格式化
        gps.formatted = gps.lat.toFixed(6) + ", " + gps.lng.toFixed(6);
    }
    // 也可能字段名不一样，兼容一下
    else if (exifData && exifData.GPSLatitude && exifData.GPSLongitude) {
        gps.lat = exifData.GPSLatitude;
        gps.lng = exifData.GPSLongitude;
        gps.hasGps = true;
        gps.formatted = gps.lat.toFixed(6) + ", " + gps.lng.toFixed(6);
    }

    return gps;
}

// ============================================================
// 3. 缩略图与主图不一致检测
// ============================================================

/**
 * 检测图片的嵌入缩略图是否和主图不一致
 * （比如照片打了马赛克，但 EXIF 里的缩略图还是原图）
 *
 * @param {File|string} fileInput - 图片文件
 * @param {ArrayBuffer} buffer - 图片二进制数据
 * @param {Object} exifData - EXIF 数据（含缩略图）
 * @returns {Promise<Object>} - 检测结果
 *
 * 原理：
 *   1. 把主图画到 Canvas A 上，缩到缩略图大小
 *   2. 把缩略图画到 Canvas B 上
 *   3. 逐像素比对两张图，计算差异比例
 *   4. 差异超过阈值 → 判定为不一致
 */
async function checkThumbnailMismatch(fileInput, buffer, exifData, maxDimension = 10000) {
    const result = {
        hasThumbnail: false,    // 是否有嵌入缩略图
        isDiff: false,          // 是否不一致
        diffPercent: 0,         // 差异百分比（0-100）
        confidence: "",         // 置信度："high" / "suspected" / "none"
        thumbnailWidth: 0,      // 缩略图宽度
        thumbnailHeight: 0,     // 缩略图高度
    };

    try {
        // ---- 第一步：获取缩略图 ----
        // 用 exifr.thumbnail(buffer) 直接提取内嵌缩略图字节。
        // 注意：不要用 exifr.parse(...) 返回的 thumbnail 字段（实测该字段拿不到），
        //       也不要用库对象 exifr.thumbnail（那永远是 undefined，就是当初的死代码）。
        let thumbnailDataUrl = null;
        try {
            if (typeof exifr.thumbnail === "function") {
                const thumb = await exifr.thumbnail(buffer); // 内嵌缩略图字节 or null
                if (thumb) {
                    thumbnailDataUrl = await blobToDataURL(
                        new Blob([thumb], { type: "image/jpeg" })
                    );
                }
            }
        } catch (err) {
            // 无缩略图或解析失败 → thumbnailDataUrl 保持 null
        }

        // 如果没拿到缩略图，说明没有嵌入缩略图，直接返回
        if (!thumbnailDataUrl) {
            return result;
        }

        result.hasThumbnail = true;

        // ---- 第二步：加载主图和缩略图 ----
        // 主图：如果是 File，转成 DataURL；否则直接用
        let mainImageUrl;
        if (fileInput instanceof File) {
            mainImageUrl = await blobToDataURL(fileInput);
        } else if (typeof fileInput === "string") {
            mainImageUrl = fileInput;
        } else {
            // 是 ArrayBuffer 的话，转成 blob 再转 DataURL
            const blob = new Blob([buffer], { type: "image/jpeg" });
            mainImageUrl = await blobToDataURL(blob);
        }

        // 加载两张图片
        const [mainImg, thumbImg] = await Promise.all([
            loadImage(mainImageUrl),
            loadImage(thumbnailDataUrl),
        ]);

        // DoS 防护：图片尺寸过大则跳过缩略图检测（避免 Canvas 占满内存）
        if (mainImg.naturalWidth > maxDimension || mainImg.naturalHeight > maxDimension) {
            console.warn(`[图片检测] 主图尺寸过大（${mainImg.naturalWidth}×${mainImg.naturalHeight}），跳过缩略图比对`);
            result.hasThumbnail = true; // 标记有缩略图，但不做比对
            result.thumbnailWidth = thumbImg.width;
            result.thumbnailHeight = thumbImg.height;
            return result;
        }

        // 记录缩略图尺寸
        result.thumbnailWidth = thumbImg.width;
        result.thumbnailHeight = thumbImg.height;

        // ---- 第三步：把主图缩到缩略图尺寸，然后逐像素比对 ----
        // 缩略图一般很小（比如 160x120），把主图缩成一样大再比
        const compareSize = Math.min(thumbImg.width, thumbImg.height, 100);
        const diffResult = compareImages(mainImg, thumbImg, compareSize);

        result.diffPercent = diffResult.percent;

        // ---- 第四步：判断结果 ----
        // 差异 < 5% → 基本一致
        if (diffResult.percent < 5) {
            result.isDiff = false;
            result.confidence = "none";
        }
        // 差异 5%-15% → 疑似（可能是压缩差异，也可能是真的不一样）
        else if (diffResult.percent < 15) {
            result.isDiff = false;
            result.confidence = "suspected";
        }
        // 差异 > 15% → 高度不一致
        else {
            result.isDiff = true;
            result.confidence = "high";
        }

    } catch (err) {
        // 缩略图检测失败不影响整体结果，保持默认值即可
    }

    return result;
}

/**
 * 把两张图画到 Canvas 上，缩放到相同尺寸，逐像素比较差异
 * @param {HTMLImageElement} img1 - 图片1（主图）
 * @param {HTMLImageElement} img2 - 图片2（缩略图）
 * @param {number} size - 比较用的尺寸（边长）
 * @returns {{ percent: number, diffPixels: number }} - 差异比例和差异像素数
 */
function compareImages(img1, img2, size) {
    // 创建两个 Canvas，尺寸相同
    const canvas1 = document.createElement("canvas");
    const canvas2 = document.createElement("canvas");
    canvas1.width = canvas2.width = size;
    canvas1.height = canvas2.height = size;

    const ctx1 = canvas1.getContext("2d");
    const ctx2 = canvas2.getContext("2d");

    // 把两张图都按"覆盖"方式画到正方形 Canvas 上（和手机缩略图行为一致）
    drawCover(ctx1, img1, size, size);
    drawCover(ctx2, img2, size, size);

    // 获取两张图的像素数据
    const data1 = ctx1.getImageData(0, 0, size, size).data;
    const data2 = ctx2.getImageData(0, 0, size, size).data;

    // 逐像素比较
    let diffPixels = 0;      // 差异像素数
    const totalPixels = size * size;  // 总像素数

    // data 是 RGBA 四个字节一组，所以 i += 4
    for (let i = 0; i < data1.length; i += 4) {
        // 计算两个像素的颜色差异（只看 RGB，不管 A）
        const rDiff = Math.abs(data1[i] - data2[i]);         // R 通道差
        const gDiff = Math.abs(data1[i + 1] - data2[i + 1]); // G 通道差
        const bDiff = Math.abs(data1[i + 2] - data2[i + 2]); // B 通道差

        // 平均差异 > 20 就算是不同的像素（阈值可以调）
        const avgDiff = (rDiff + gDiff + bDiff) / 3;
        if (avgDiff > 20) {
            diffPixels++;
        }
    }

    // 返回差异百分比
    return {
        percent: (diffPixels / totalPixels) * 100,
        diffPixels: diffPixels,
    };
}

/**
 * 以"覆盖"(cover) 方式把图片画到 Canvas 上
 * （类似 CSS 的 background-size: cover，图片填满容器，超出部分裁掉）
 * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
 * @param {HTMLImageElement} img - 图片
 * @param {number} w - 目标宽度
 * @param {number} h - 目标高度
 */
function drawCover(ctx, img, w, h) {
    // 计算图片宽高比
    const imgRatio = img.width / img.height;
    const targetRatio = w / h;

    let sx, sy, sw, sh; // 源图的裁剪区域

    if (imgRatio > targetRatio) {
        // 图片更宽 → 裁掉左右两边
        sh = img.height;
        sw = img.height * targetRatio;
        sx = (img.width - sw) / 2;
        sy = 0;
    } else {
        // 图片更高 → 裁掉上下两边
        sw = img.width;
        sh = img.width / targetRatio;
        sx = 0;
        sy = (img.height - sh) / 2;
    }

    // 画到 Canvas 上
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

// ============================================================
// 4. 图片内容个人信息（PII）检测
// ============================================================

/**
 * 获取 OCR 配置（使用绝对路径，因为 Worker 内部的 importScripts 不支持相对路径）
 * @returns {Object} OCR 配置对象
 */
function getOcrConfig() {
    const isFileProtocol = window.location.protocol === "file:";
    let baseUrl;

    if (isFileProtocol) {
        // file:// 协议下，尝试从当前页面路径推导
        const path = window.location.pathname;
        const lastSlash = path.lastIndexOf('/');
        baseUrl = "file://" + path.substring(0, lastSlash + 1);
    } else {
        baseUrl = window.location.origin + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
    }

    return {
        workerPath: baseUrl + "lib/tesseract/worker.min.js",
        corePath: baseUrl + "lib/tesseract/tesseract-core.wasm.js",
        langPath: baseUrl + "lib/tesseract/",
        isFileProtocol: isFileProtocol,
    };
}

/**
 * 判断当前是否运行在 Electron（桌面版 exe）环境中。
 * Electron 的渲染进程即使以 file:// 加载，其 Chromium 也允许 Web Worker 运行本地脚本，
 * 因此不需要像普通浏览器那样禁用 file:// 下的 OCR。
 */
function isElectronEnv() {
    try {
        if (typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent)) return true;
        if (typeof window !== "undefined" && window.process && window.process.versions && window.process.versions.electron) return true;
    } catch (e) { /* 忽略 */ }
    return false;
}

/**
 * 检查 OCR 是否可用（file:// 协议下 Web Worker 可能被禁止）
 * @returns {Object} { available: boolean, reason: string }
 */
function checkOcrAvailability() {
    if (typeof Tesseract === "undefined") {
        return { available: false, reason: "Tesseract.js 库未加载" };
    }

    const config = getOcrConfig();

    // file:// 协议下，Chrome 等浏览器禁止 Web Worker 加载本地文件；
    // 但 Electron 桌面版不受此限（UA 含 Electron），放行以支持 exe 内 OCR。
    if (config.isFileProtocol && !isElectronEnv()) {
        return {
            available: false,
            reason: "当前为本地文件模式（file:// 协议），浏览器安全策略禁止文字识别功能。请使用本地服务器打开本工具（如 Python 的 python -m http.server）。"
        };
    }

    return { available: true, reason: null };
}

/**
 * 对图片进行 OCR 文字识别
 * @param {string|File|HTMLImageElement|HTMLCanvasElement} imageSource - 图片源
 * @param {string} langs - 识别语言，如 'chi_sim+eng'
 * @returns {Promise<Array>} 识别出的文字块数组 [{ text, bbox: {x0, y0, x1, y1}, confidence }]
 */
async function runOCR(imageSource, langs = "chi_sim+eng") {
    const availability = checkOcrAvailability();
    if (!availability.available) {
        console.warn("[OCR] 不可用:", availability.reason);
        throw new Error(availability.reason);
    }

    const config = getOcrConfig();
    let worker = null;

    try {
        // Tesseract.js v4 API 正确调用序列：
        // 1. createWorker(options) — 创建 Worker
        // 2. loadLanguage(langs)   — 加载语言包
        // 3. initialize(langs, oem) — 初始化引擎（OEM=1 表示 LSTM 引擎）
        // 4. recognize(imageSource) — 识别图片
        // workerBlobURL: false — 禁用 Blob 包装，直接 new Worker(workerPath)，
        // 避免 importScripts 的路径问题
        console.log("[OCR] 正在创建 Worker...");
        worker = await Tesseract.createWorker({
            workerPath: config.workerPath,
            corePath: config.corePath,
            langPath: config.langPath,
            workerBlobURL: false,
            logger: m => {
                if (m.status) {
                    console.log(`[OCR] ${m.status}${m.progress ? ' (' + Math.round(m.progress * 100) + '%)' : ''}`);
                }
            },
        });
        console.log("[OCR] Worker 创建成功，正在加载语言包...");
        await worker.loadLanguage(langs);
        console.log("[OCR] 语言包加载完成，正在初始化引擎...");
        await worker.initialize(langs, 1); // OEM 1 = Tesseract 引擎（LSTM）
        console.log("[OCR] 引擎初始化完成，开始识别...");

        const { data } = await worker.recognize(imageSource);

        // 同时收集 words 和 lines
        // words 用于英文/数字等细粒度匹配
        // lines 用于中文标签匹配（中文 OCR 常把每个汉字拆成一个 word）
        const words = [];
        if (data.words && data.words.length > 0) {
            for (const w of data.words) {
                if (w.text && w.text.trim()) {
                    words.push({
                        text: w.text.trim(),
                        bbox: {
                            x0: w.bbox.x0,
                            y0: w.bbox.y0,
                            x1: w.bbox.x1,
                            y1: w.bbox.y1,
                        },
                        confidence: w.confidence || 0,
                    });
                }
            }
        }

        const lines = [];
        if (data.lines && data.lines.length > 0) {
            for (const line of data.lines) {
                if (line.text && line.text.trim()) {
                    lines.push({
                        text: line.text.trim(),
                        // 去掉中文之间的空格，便于标签匹配
                        cleanText: line.text.replace(/\s+/g, ""),
                        bbox: {
                            x0: line.bbox.x0,
                            y0: line.bbox.y0,
                            x1: line.bbox.x1,
                            y1: line.bbox.y1,
                        },
                        confidence: line.confidence || 0,
                        words: line.words ? line.words.map(w => ({
                            text: w.text.trim(),
                            bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
                            confidence: w.confidence || 0,
                        })).filter(w => w.text) : [],
                    });
                }
            }
        }

        return { words, lines };
    } catch (err) {
        console.warn("[OCR] 识别失败:", err.message);
        throw err;
    } finally {
        if (worker) {
            try {
                await worker.terminate();
            } catch (e) {
                // 忽略终止时的错误
            }
        }
    }
}

/**
 * 检测图片中的个人信息（PII）
 * @param {File|string} fileInput - 图片文件
 * @returns {Promise<Object>} PII 检测结果
 *   {
 *     hasPii: boolean,           // 是否检测到个人信息
 *     items: Array<Object>,      // 检测到的个人信息列表
 *     ocrAvailable: boolean,     // OCR 是否可用
 *     error: string|null         // 错误信息
 *   }
 *
 * 每个 item 的格式：
 *   {
 *     type: "id_card" | "phone" | "name" | "address",  // 信息类型
 *     typeLabel: string,       // 类型中文名
 *     value: string,           // 识别到的内容
 *     bbox: {x0, y0, x1, y1},  // 在图片中的位置（像素坐标）
 *     confidence: number,      // 置信度 0-100
 *   }
 */
async function detectImagePii(fileInput) {
    const result = {
        hasPii: false,
        items: [],
        ocrAvailable: false,
        error: null,
    };

    // 如果 Tesseract 未加载，直接返回（不影响其他检测）
    if (typeof Tesseract === "undefined") {
        result.error = "OCR 引擎未加载，跳过图片内容识别";
        return result;
    }

    try {
        // 获取图片的 dataURL 或 File 对象
        let imageSource;
        if (fileInput instanceof File) {
            imageSource = await blobToDataURL(fileInput);
        } else if (typeof fileInput === "string") {
            imageSource = fileInput;
        } else {
            imageSource = fileInput;
        }

        // 运行 OCR 识别（带超时保护，避免卡住太久）
        const ocrPromise = runOCR(imageSource);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("OCR 识别超时（120秒）")), 120000);
        });

        let ocrResult;
        try {
            ocrResult = await Promise.race([ocrPromise, timeoutPromise]);
        } catch (ocrErr) {
            // 兼容各种错误格式（Error 对象、字符串、Event 对象等）
            let errMsg = "未知错误";
            if (ocrErr && typeof ocrErr === "string") {
                errMsg = ocrErr;
            } else if (ocrErr && ocrErr.message) {
                errMsg = ocrErr.message;
            } else if (ocrErr && ocrErr.error) {
                errMsg = typeof ocrErr.error === "string" ? ocrErr.error : JSON.stringify(ocrErr.error);
            } else if (ocrErr && typeof ocrErr === "object") {
                try {
                    errMsg = JSON.stringify(ocrErr).substring(0, 200);
                } catch (e) {
                    errMsg = String(ocrErr);
                }
            }
            console.warn("[PII检测] OCR 失败:", errMsg);
            result.error = "文字识别失败：" + errMsg;
            return result;
        }

        const { words, lines } = ocrResult;
        result.ocrAvailable = lines.length > 0 || words.length > 0;

        if (lines.length === 0 && words.length === 0) {
            return result;
        }

        // 从 OCR 结果中提取个人信息（主要基于行数据，中文 OCR 更准）
        const piiItems = extractPiiFromOcr(lines, words);
        result.items = piiItems;
        result.hasPii = piiItems.length > 0;

    } catch (err) {
        result.error = err.message || "PII 检测失败";
        console.warn("[PII检测] 失败:", err.message);
    }

    return result;
}

/**
 * 从 OCR 识别结果中提取个人信息（基于行数据，中文 OCR 更准）
 * @param {Array} lines - OCR 行数据 [{ text, cleanText, bbox, words, confidence }]
 * @param {Array} words - OCR 词数据（用于英文/数字细粒度匹配）
 * @returns {Array} PII 项数组
 */
function extractPiiFromOcr(lines, words) {
    const items = [];
    const foundIds = new Set(); // 去重

    // 地址关键词
    const addressKeywords = ["省", "市", "区", "县", "镇", "乡", "村", "街", "路", "巷", "号", "楼", "室", "小区", "大厦", "公寓"];

    // 先检查每一行（中文标签匹配）
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const text = line.cleanText; // 已去掉空格的文本
        const fullText = line.text;  // 原始文本（带空格）

        // =====================================================
        // 1. 身份证号（18位，最后一位可能是 X）
        // =====================================================
        const idCardRegex = /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;
        let idMatch;
        idCardRegex.lastIndex = 0;
        while ((idMatch = idCardRegex.exec(text)) !== null) {
            const idNum = idMatch[0].toUpperCase();
            const key = "id_" + idNum;
            if (!foundIds.has(key)) {
                foundIds.add(key);
                // 身份证号通常是数字，直接用整行 bbox，或者找到对应的 word
                const idWord = findWordForSubstring(line, idMatch.index, idMatch[0].length);
                items.push({
                    type: "id_card",
                    typeLabel: "身份证号",
                    value: maskIdCard(idNum),
                    rawValue: idNum,
                    bbox: idWord || { ...line.bbox },
                        rowBbox: { ...line.bbox },
                    confidence: line.confidence,
                });
            }
        }

        // =====================================================
        // 2. 手机号（11位，1开头）
        // =====================================================
        const phoneRegex = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
        let phoneMatch;
        phoneRegex.lastIndex = 0;
        while ((phoneMatch = phoneRegex.exec(text)) !== null) {
            const phoneNum = phoneMatch[0];
            const key = "phone_" + phoneNum;
            if (!foundIds.has(key)) {
                foundIds.add(key);
                const phoneWord = findWordForSubstring(line, phoneMatch.index, phoneMatch[0].length);
                items.push({
                    type: "phone",
                    typeLabel: "手机号",
                    value: maskPhone(phoneNum),
                    rawValue: phoneNum,
                    bbox: phoneWord || { ...line.bbox },
                        rowBbox: { ...line.bbox },
                    confidence: line.confidence,
                });
            }
        }

        // =====================================================
        // 3. 姓名检测（"姓名xxx" 格式）
        // =====================================================
        const nameMatch = text.match(/姓名([\u4e00-\u9fa5]{2,4})/);
        if (nameMatch) {
            const name = nameMatch[1];
            const key = "name_" + name;
            if (!foundIds.has(key) && isValidChineseName(name)) {
                foundIds.add(key);
                const nameBbox = findSubstringBbox(line, nameMatch.index + 2, name.length); // "姓名"占2字
                items.push({
                    type: "name",
                    typeLabel: "姓名",
                    value: name,
                    rawValue: name,
                    bbox: nameBbox || { ...line.bbox },
                        rowBbox: { ...line.bbox },
                    confidence: line.confidence,
                });
            }
        }

        // =====================================================
        // 4. 性别检测（"性别男/女" 格式）
        // =====================================================
        const genderMatch = text.match(/性别([男女])/);
        if (genderMatch) {
            const gender = genderMatch[1];
            const key = "gender_" + gender;
            if (!foundIds.has(key)) {
                foundIds.add(key);
                const genderBbox = findSubstringBbox(line, genderMatch.index + 2, 1); // "性别"占2字
                items.push({
                    type: "gender",
                    typeLabel: "性别",
                    value: gender,
                    rawValue: gender,
                    bbox: genderBbox || { ...line.bbox },
                        rowBbox: { ...line.bbox },
                    confidence: line.confidence,
                });
            }
        }

        // =====================================================
        // 5. 出生日期检测
        // =====================================================
        const birthMatch = text.match(/出生(?:日期)?(\d{4})年(\d{1,2})月(\d{1,2})日?/);
        if (birthMatch) {
            const year = birthMatch[1];
            const month = birthMatch[2].padStart(2, "0");
            const day = birthMatch[3].padStart(2, "0");
            const birthDate = `${year}年${month}月${day}日`;
            const key = "birth_" + year + month + day;

            if (!foundIds.has(key) && year >= 1900 && year <= 2100
                && parseInt(month) >= 1 && parseInt(month) <= 12
                && parseInt(day) >= 1 && parseInt(day) <= 31) {
                foundIds.add(key);
                const birthBbox = findSubstringBbox(line, birthMatch.index + 2, birthMatch[0].length - 2);
                items.push({
                    type: "birth_date",
                    typeLabel: "出生日期",
                    value: `${year}年**月**日`,
                    rawValue: birthDate,
                    bbox: birthBbox || { ...line.bbox },
                        rowBbox: { ...line.bbox },
                    confidence: line.confidence,
                });
            }
        }

        // =====================================================
        // 6. 民族检测
        // =====================================================
        const ethnicMatch = text.match(/民族([\u4e00-\u9fa5]{1,4})/);
        if (ethnicMatch) {
            const ethnicName = ethnicMatch[1];
            // 验证是否为有效民族名
            const validEthnics = ["汉", "蒙古", "回", "藏", "维吾尔", "苗", "彝", "壮", "布依", "朝鲜",
                "满", "侗", "瑶", "白", "土家", "哈尼", "哈萨克", "傣", "黎", "傈僳",
                "佤", "畲", "高山", "拉祜", "水", "东乡", "纳西", "景颇", "柯尔克孜", "土",
                "达斡尔", "仫佬", "羌", "布朗", "撒拉", "毛南", "仡佬", "锡伯", "阿昌", "普米"];
            if (validEthnics.includes(ethnicName)) {
                const key = "ethnic_" + ethnicName;
                if (!foundIds.has(key)) {
                    foundIds.add(key);
                    const ethnicBbox = findSubstringBbox(line, ethnicMatch.index + 2, ethnicName.length);
                    items.push({
                        type: "ethnic",
                        typeLabel: "民族",
                        value: ethnicName,
                        rawValue: ethnicName,
                        bbox: ethnicBbox || { ...line.bbox },
                            rowBbox: { ...line.bbox },
                        confidence: line.confidence,
                    });
                }
            }
        }

        // =====================================================
        // 7. 地址检测（"住址xxx" 或 "地址xxx" 格式）
        // =====================================================
        const addrMatch = text.match(/(?:住址|地址)(.+)$/);
        if (addrMatch) {
            const addr = addrMatch[1];
            if (addr.length >= 3 && containsAddressKeyword(addr, addressKeywords)) {
                const key = "addr_line_" + i; // 按行去重
                if (!foundIds.has(key)) {
                    foundIds.add(key);
                    // 地址 bbox 从标签后开始，精确匹配文字范围
                    const addrStartChar = addrMatch.index + 2; // "住址"/"地址"占2字
                    const addrBbox = findSubstringBbox(line, addrStartChar, addr.length);
                    // 如果找不到精确 bbox，就用从标签后到行尾的范围（保守估计）
                    const finalBbox = addrBbox || {
                        x0: line.bbox.x0 + Math.round((line.bbox.x1 - line.bbox.x0) * 0.3),
                        y0: line.bbox.y0,
                        x1: line.bbox.x1,
                        y1: line.bbox.y1,
                    };
                    // 稍微扩大 bbox，确保完全覆盖（上下左右各加 2px）
                    finalBbox.x0 = Math.max(0, finalBbox.x0 - 2);
                    finalBbox.y0 = Math.max(0, finalBbox.y0 - 2);
                    finalBbox.x1 = finalBbox.x1 + 2;
                    finalBbox.y1 = finalBbox.y1 + 2;

                    items.push({
                        type: "address",
                        typeLabel: "地址",
                        value: maskAddress(addr),
                        rawValue: addr,
                        bbox: finalBbox,
                            rowBbox: finalBbox,
                        confidence: line.confidence,
                        _lineIndex: i, // 记录行号，用于后续跨行合并
                    });
                }
            }
        }
    }

    // =====================================================
    // 额外：地址跨行合并（身份证住址常跨 2-3 行）
    // 策略：
    //   1. 优先找有"住址/地址"标签的行，从它开始向下合并
    //   2. 如果没找到标签行，找连续包含地址关键词的行合并
    // =====================================================
    (function mergeAddressLines() {
        // 先找有没有"住址/地址"标签的行
        // 支持 OCR 常见误识别：住止、住地、位址、往址、任址、住所、住坊等
        let startIdx = -1;
        const addrLabelRegex = /^(?:住址|地址|住止|住地|位址|往址|任址|住所|住坊|住址)/;
        for (let i = 0; i < lines.length; i++) {
            if (addrLabelRegex.test(lines[i].cleanText)) {
                startIdx = i;
                break;
            }
        }
        // 如果行首没匹配到，试试行内是否包含标签（OCR可能把标签和前面的字连在一起）
        if (startIdx === -1) {
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].cleanText;
                if (/住址|地址/.test(t) && containsAddressKeyword(t, addressKeywords)) {
                    startIdx = i;
                    break;
                }
            }
        }

        // 收集地址行
        let addrLineIndices = [];

        if (startIdx !== -1) {
            // 有标签：从标签行开始，向下收集包含地址关键词的连续行
            // 遇到"公民身份号码"等明确标签就停止
            addrLineIndices.push(startIdx);
            for (let j = startIdx + 1; j < Math.min(lines.length, startIdx + 4); j++) {
                const nextClean = lines[j].cleanText;
                // 遇到这些标签行说明地址区域结束了
                if (/^(?:公民身份号码|公民|身份号码|签发机关|有效期限|签发|有效|期限|编号)/.test(nextClean)) {
                    break;
                }
                // 遇到其他字段标签也停止
                if (/^(?:姓名|性别|民族|出生)/.test(nextClean)) {
                    break;
                }
                // 必须包含地址关键词才算地址行
                if (nextClean.length >= 2 && containsAddressKeyword(nextClean, addressKeywords)) {
                    addrLineIndices.push(j);
                } else {
                    break;
                }
            }
        } else {
            // 无标签：先用出生行和身份证号行界定搜索范围，然后在范围内找地址
            // 身份证布局：姓名 → 性别民族 → 出生 → 住址(2-3行) → 公民身份号码
            let birthLineIdx = -1;
            let idNumLineIdx = -1;

            // 找出生行
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].cleanText;
                if (/出生/.test(t) && /\d{4}.*年.*\d{1,2}.*月/.test(t)) {
                    birthLineIdx = i;
                    break;
                }
            }
            if (birthLineIdx === -1) {
                for (let i = 0; i < lines.length; i++) {
                    if (/出生/.test(lines[i].cleanText)) {
                        birthLineIdx = i;
                        break;
                    }
                }
            }

            // 找身份证号行
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].cleanText;
                if (/[1-9]\d{5}(?:19|20)\d{2}\d{7}[\dXx]/.test(t)) {
                    idNumLineIdx = i;
                    break;
                }
                if (/公民身份号码/.test(t)) {
                    if (/\d{17}[\dXx]/.test(t)) {
                        idNumLineIdx = i;
                    } else {
                        idNumLineIdx = i + 1;
                    }
                    break;
                }
                if (/^(?:身份号码|公民身份)/.test(t)) {
                    idNumLineIdx = i + 1;
                    break;
                }
            }

            // 确定搜索范围：出生行下一行 到 身份证号行上一行
            const searchStart = birthLineIdx !== -1 ? birthLineIdx + 1 : 0;
            const searchEnd = idNumLineIdx !== -1 ? idNumLineIdx - 1 : lines.length - 1;

            // 在范围内找连续包含地址关键词的行
            let consecutiveStart = -1;
            let consecutiveCount = 0;
            let bestStart = -1;
            let bestCount = 0;

            for (let i = searchStart; i <= searchEnd && i < lines.length; i++) {
                const cleanText = lines[i].cleanText;
                if (cleanText.length < 2) {
                    if (consecutiveCount > bestCount) {
                        bestStart = consecutiveStart;
                        bestCount = consecutiveCount;
                    }
                    consecutiveStart = -1;
                    consecutiveCount = 0;
                    continue;
                }
                const chineseCount = (cleanText.match(/[\u4e00-\u9fa5]/g) || []).length;
                const digitCount = (cleanText.match(/\d/g) || []).length;
                if (chineseCount + digitCount < 2) {
                    if (consecutiveCount > bestCount) {
                        bestStart = consecutiveStart;
                        bestCount = consecutiveCount;
                    }
                    consecutiveStart = -1;
                    consecutiveCount = 0;
                    continue;
                }
                // 遇到明确的标签行就停止
                if (/^(?:姓名|性别|民族|出生|公民|身份|签发|有效|期限|编号)/.test(cleanText)) {
                    if (consecutiveCount > bestCount) {
                        bestStart = consecutiveStart;
                        bestCount = consecutiveCount;
                    }
                    consecutiveStart = -1;
                    consecutiveCount = 0;
                    continue;
                }
                if (containsAddressKeyword(cleanText, addressKeywords)) {
                    if (consecutiveStart === -1) consecutiveStart = i;
                    consecutiveCount++;
                } else {
                    if (consecutiveCount > bestCount) {
                        bestStart = consecutiveStart;
                        bestCount = consecutiveCount;
                    }
                    consecutiveStart = -1;
                    consecutiveCount = 0;
                }
            }
            if (consecutiveCount > bestCount) {
                bestStart = consecutiveStart;
                bestCount = consecutiveCount;
            }

            if (bestCount >= 1 && bestStart !== -1) {
                for (let k = 0; k < bestCount; k++) {
                    addrLineIndices.push(bestStart + k);
                }
            }
        }

        if (addrLineIndices.length === 0) return;

        const firstLine = lines[addrLineIndices[0]];
        const lastLine = lines[addrLineIndices[addrLineIndices.length - 1]];

        // 删除之前所有单独的地址项（用合并后的替换）
        for (let idx = items.length - 1; idx >= 0; idx--) {
            if (items[idx].type === "address") {
                items.splice(idx, 1);
            }
        }

        // 计算合并后的 bbox
        // 核心策略：每行都用 words 精确定位实际文字范围，不取整行
        // 第一行如果有标签，从标签后面的文字开始
        let baseX0 = Infinity, baseX1 = 0;  // 地址文字的 x 范围
        let minY = Infinity, maxY = 0;       // 全部 y 范围
        let hasFirstLineLabel = false;       // 第一行是否有标签

        for (let i = 0; i < addrLineIndices.length; i++) {
            const idx = addrLineIndices[i];
            const l = lines[idx];
            const isFirstLine = i === 0;

            // 地址区域完整覆盖：直接使用整行 bbox，不做精确裁剪。
            // 原因：OCR 常漏字（如"北京市"识别成"京市"）或文字超出识别框，
            // 用 words 精确框会导致地址露边。用户要求"完整、不可还原"优先于"只遮地址"。
            let lineTextX0 = l.bbox.x0;
            let lineTextX1 = l.bbox.x1;

            // 若有地址标签，把标签也纳入覆盖范围（标签到内容整段遮住）
            if (addrLabelRegex.test(l.cleanText)) {
                hasFirstLineLabel = true;
            }

            // 更新 y 范围（所有行都参与）
            minY = Math.min(minY, l.bbox.y0);
            maxY = Math.max(maxY, l.bbox.y1);

            // 更新 x 范围（所有行都参与，因为每行都是地址的一部分）
            baseX0 = Math.min(baseX0, lineTextX0);
            baseX1 = Math.max(baseX1, lineTextX1);
        }

        // 如果没有找到有效 x 范围，用第一行和最后一行的文字区域兜底
        if (baseX0 === Infinity) {
            baseX0 = lines[addrLineIndices[0]].bbox.x0;
            baseX1 = lines[addrLineIndices[addrLineIndices.length - 1]].bbox.x1;
        }

        // 用身份证上各字段的值位置作为地址边界参考
        // 核心原则：地址文字和其他字段值左对齐，且不超过身份证号行的右边界
        let nameValueX0 = -1;       // 姓名值的左边界（用于左对齐）
        let idNumValueX1 = -1;      // 身份证号值的右边界（用于右边界上限）
        let fieldValueX1s = [];     // 收集所有字段值的右边界
        let birthLineY1 = -1;       // 出生行的下边界（用于限制地址上边界）

        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].cleanText;
            const line = lines[i];

            // 姓名行
            const nameMatch = t.match(/姓名([\u4e00-\u9fa5]{2,4})/);
            if (nameMatch && isValidChineseName(nameMatch[1])) {
                const subBbox = findSubstringBbox(line, nameMatch.index + 2, nameMatch[1].length);
                if (subBbox) {
                    nameValueX0 = subBbox.x0;
                    fieldValueX1s.push(subBbox.x1);
                }
            }

            // 出生行
            const birthMatch = t.match(/出生(?:日期)?(\d{4})年(\d{1,2})月(\d{1,2})日?/);
            if (birthMatch) {
                const subBbox = findSubstringBbox(line, birthMatch.index + 2, birthMatch[0].length - 2);
                if (subBbox) {
                    fieldValueX1s.push(subBbox.x1);
                }
                birthLineY1 = line.bbox.y1; // 记录出生行的下边界
            }

            // 性别民族行
            const genderEthnicMatch = t.match(/性别[男女].*民族[\u4e00-\u9fa5]{1,4}/);
            if (genderEthnicMatch) {
                const subBbox = findSubstringBbox(line, genderEthnicMatch.index, genderEthnicMatch[0].length);
                if (subBbox) {
                    fieldValueX1s.push(subBbox.x1);
                }
            }

            // 身份证号行（最可靠的右边界参考，因为身份证号最长）
            const idMatch = t.match(/[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/);
            if (idMatch) {
                const subBbox = findSubstringBbox(line, idMatch.index, idMatch[0].length);
                if (subBbox) {
                    idNumValueX1 = subBbox.x1;
                    fieldValueX1s.push(subBbox.x1);
                }
            }
            // "公民身份号码" + 数字的行
            if (/公民身份号码.*\d{17}[\dXx]/.test(t)) {
                const numMatch = t.match(/\d{17}[\dXx]/);
                if (numMatch) {
                    const subBbox = findSubstringBbox(line, numMatch.index, numMatch[0].length);
                    if (subBbox) {
                        idNumValueX1 = subBbox.x1;
                        fieldValueX1s.push(subBbox.x1);
                    }
                }
            }
        }

        // 左边界：放宽，避免把"住址"标签/左端内容截掉
        if (nameValueX0 > 0 && baseX0 < nameValueX0 - 30) {
            baseX0 = nameValueX0 - 8;
        }

        // 右边界：放宽上限，避免地址右端（如"8号院""210室"）被截断导致露字。
        // 以身份证号行右边界 + 40px 为宽松上限；拿不到则用最宽字段 + 60px。
        // 身份证号通常是整卡最宽的字段，地址不可能比它更宽，故不会过度遮挡。
        let maxAddrX1 = -1;
        if (idNumValueX1 > 0) {
            maxAddrX1 = idNumValueX1 + 40;
        } else if (fieldValueX1s.length > 0) {
            maxAddrX1 = Math.max(...fieldValueX1s) + 60;
        }
        if (maxAddrX1 > 0 && baseX1 > maxAddrX1) {
            baseX1 = maxAddrX1;
        }

        // 上边界：放宽，出生行本身也是敏感信息，略重叠无妨
        if (birthLineY1 > 0 && minY < birthLineY1 + 2) {
            minY = birthLineY1 + 2;
        }

        // x/y 范围加大余量，确保覆盖完整、不露边（用户要求"完整、不可还原"优先）
        const finalX0 = Math.max(0, baseX0 - 6);
        const finalY0 = Math.max(0, minY - 4);
        const finalX1 = baseX1 + 6;
        const finalY1 = maxY + 4;

        // 合并地址文本
        const fullAddr = addrLineIndices.map((idx, k) => {
            const l = lines[idx];
            if (k === 0 && /^(?:住址|地址)/.test(l.cleanText)) {
                return l.cleanText.replace(/^(?:住址|地址)/, "");
            }
            return l.cleanText;
        }).join("");

        const key = "addr_merged_" + addrLineIndices.join("_");
        if (!foundIds.has(key)) {
            foundIds.add(key);
            items.push({
                type: "address",
                typeLabel: "地址",
                value: maskAddress(fullAddr),
                rawValue: fullAddr,
                bbox: { x0: Math.round(finalX0), y0: Math.round(finalY0), x1: Math.round(finalX1), y1: Math.round(finalY1) },
                confidence: Math.min(...addrLineIndices.map(idx => lines[idx].confidence)),
            });
        }
    })();

    // =====================================================
    // 后处理：统一收紧所有地址条目的 bbox 边界
    // 避免 OCR 把人像区域的噪点识别成文字导致 bbox 过大
    // =====================================================
    (function tightenAddressBboxes() {
        // 找出生日期的值右边界作为参考（地址和出生的值宽度差不多）
        let birthValueX1 = -1;
        // 找姓名值的左边界作为参考（地址和姓名左对齐）
        let nameValueX0 = -1;
        // 找出生行的下边界（地址不能盖住出生日期）
        let birthLineY1 = -1;

        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].cleanText;
            const line = lines[i];

            // 姓名行
            const nameMatch = t.match(/姓名([\u4e00-\u9fa5]{2,4})/);
            if (nameMatch && isValidChineseName(nameMatch[1])) {
                const subBbox = findSubstringBbox(line, nameMatch.index + 2, nameMatch[1].length);
                if (subBbox) nameValueX0 = subBbox.x0;
            }

            // 出生行
            const birthMatch = t.match(/出生(?:日期)?(\d{4})年(\d{1,2})月(\d{1,2})日?/);
            if (birthMatch) {
                const subBbox = findSubstringBbox(line, birthMatch.index + 2, birthMatch[0].length - 2);
                if (subBbox) birthValueX1 = subBbox.x1;
                birthLineY1 = line.bbox.y1;
                break;
            }
        }

        // 对所有地址条目收紧边界
        for (const item of items) {
            if (item.type !== "address") continue;

            // 左边界：对齐姓名值
            if (nameValueX0 > 0 && item.bbox.x0 < nameValueX0 - 5) {
                item.bbox.x0 = Math.round(nameValueX0 - 2);
            }

            // 右边界：不超过出生日期值 + 40px（约 2 个字的余量）
            if (birthValueX1 > 0) {
                const maxX1 = birthValueX1 + 40;
                if (item.bbox.x1 > maxX1) {
                    item.bbox.x1 = Math.round(maxX1);
                }
            }

            // 上边界：不能低于出生行下边界
            if (birthLineY1 > 0 && item.bbox.y0 < birthLineY1) {
                item.bbox.y0 = Math.round(birthLineY1 + 3);
            }
        }
    })();

    // 清理内部用的 _lineIndex 属性
    items.forEach(item => delete item._lineIndex);

    return items;
}

/**
 * 在一行中找到指定位置子串对应的 bbox
 * @param {Object} line - 行数据
 * @param {number} charIndex - 子串在 cleanText 中的起始字符位置
 * @param {number} charLength - 子串长度（字符数）
 * @returns {Object|null} bbox 对象 {x0, y0, x1, y1} 或 null
 */
function findWordForSubstring(line, charIndex, charLength) {
    if (!line.words || line.words.length === 0) return null;

    // 计算每个 word 在 cleanText 中的字符偏移
    // 由于中文每个字可能是一个 word，数字/英文可能合并成一个 word，
    // 我们需要逐字累加来定位
    let currentCharIdx = 0;
    let startWord = null;
    let endWord = null;

    for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i];
        const wordText = word.text.replace(/\s+/g, ""); // 去掉空格
        if (wordText.length === 0) continue;

        const wordStart = currentCharIdx;
        const wordEnd = currentCharIdx + wordText.length - 1;

        if (startWord === null && charIndex <= wordEnd) {
            startWord = word;
        }
        if (charIndex + charLength - 1 <= wordEnd) {
            endWord = word;
            break;
        }

        currentCharIdx += wordText.length;
    }

    // 如果没找到 endWord，用最后一个 word
    if (!endWord && line.words.length > 0) {
        endWord = line.words[line.words.length - 1];
    }
    if (!startWord && line.words.length > 0) {
        startWord = line.words[0];
    }

    if (!startWord || !endWord) return null;

    return {
        x0: startWord.bbox.x0,
        y0: startWord.bbox.y0,
        x1: endWord.bbox.x1,
        y1: endWord.bbox.y1,
    };
}

/**
 * 计算行内指定字符位置范围的 bbox
 * @param {Object} line - 行数据
 * @param {number} startChar - 起始字符位置（cleanText 中）
 * @param {number} length - 字符长度
 * @returns {Object|null} bbox
 */
function findSubstringBbox(line, startChar, length) {
    return findWordForSubstring(line, startChar, length);
}

/**
 * 判断是否为有效的中文姓名（2-4个中文字符，且不是常见的非姓名字）
 * @param {string} name
 * @returns {boolean}
 */
function isValidChineseName(name) {
    // 长度 2-4 个中文字符
    if (!/^[\u4e00-\u9fa5]{2,4}$/.test(name)) return false;

    // 排除常见的非姓名词汇
    const excludeWords = ["身份证", "手机号", "电话号", "地址", "姓名", "出生", "性别", "民族", "住址",
        "公司", "单位", "学校", "备注", "说明", "日期", "编号", "代码", "类型", "状态"];
    for (const w of excludeWords) {
        if (name.includes(w)) return false;
    }

    return true;
}

/**
 * 检查文本是否包含地址关键词
 * @param {string} text
 * @param {string[]} keywords
 * @returns {boolean}
 */
function containsAddressKeyword(text, keywords) {
    for (const kw of keywords) {
        if (text.includes(kw)) return true;
    }
    return false;
}

/**
 * 脱敏身份证号（保留前6后4，中间用*代替）
 * @param {string} idNum
 * @returns {string}
 */
function maskIdCard(idNum) {
    if (idNum.length < 10) return idNum;
    return idNum.substring(0, 6) + "********" + idNum.substring(idNum.length - 4);
}

/**
 * 脱敏手机号（保留前3后4，中间用*代替）
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
    if (phone.length < 11) return phone;
    return phone.substring(0, 3) + "****" + phone.substring(phone.length - 4);
}

/**
 * 脱敏地址（只保留到区/县一级，后面用*代替）
 * @param {string} addr
 * @returns {string}
 */
function maskAddress(addr) {
    // 找到"区"或"县"的位置，保留到那里
    const match = addr.match(/^(.+?(?:区|县|市))/);
    if (match) {
        return match[1] + "****";
    }
    // 否则只保留前6个字符
    if (addr.length > 6) {
        return addr.substring(0, 6) + "****";
    }
    return addr;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 加载一张图片，返回 Image 对象（Promise 包装）
 * @param {string} src - 图片地址或 dataURL
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        // 图片加载成功
        img.onload = () => resolve(img);
        // 图片加载失败
        img.onerror = () => reject(new Error("图片加载失败"));
        // 设置跨域（如果是网络图片的话）
        img.crossOrigin = "anonymous";
        img.src = src;
    });
}

/**
 * Blob 转 DataURL
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

// ============================================================
// 导出到全局
// ============================================================
/**
 * 检测图片中的所有可识别文字（全图文字）
 * 优先使用 PaddleOCR.js（深度学习 OCR，对招牌/路标识别率高）
 * 如果 PaddleOCR.js 不可用则自动降级到 Tesseract.js
 */
async function detectAllImageText(fileInput) {
    const result = {
        hasText: false, items: [], lines: [], words: [],
        ocrAvailable: false, engine: null, error: null,
    };
    let imageSource = fileInput;

    // 优先 PaddleOCR.js
    if (window.PaddleOCR) {
        try {
            const poResult = await detectWithPaddleOCR(imageSource);
            if (poResult.success) {
                Object.assign(result, poResult.data);
                result.engine = 'PaddleOCR.js';
                console.log('[全图文字检测] PaddleOCR.js 识别到 ' + result.items.length + ' 处文字');
                return result;
            }
            console.warn('[全图文字检测] PaddleOCR.js 未检测到文字，降级');
        } catch (e) {
            console.warn('[全图文字检测] PaddleOCR.js 失败，降级:', e.message);
        }
    }

    // 降级 Tesseract.js
    result.engine = 'Tesseract.js';
    if (typeof Tesseract === 'undefined') { result.error = 'OCR 引擎未加载'; return result; }
    try {
        const ocrPromise = runOCR(imageSource);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OCR 识别超时（120秒）')), 120000));
        let ocrResult;
        try { ocrResult = await Promise.race([ocrPromise, timeoutPromise]); }
        catch (ocrErr) {
            result.error = '文字识别失败：' + String((ocrErr && (ocrErr.message || ocrErr.error)) || '未知错误');
            return result;
        }
        const { words, lines } = ocrResult;
        result.ocrAvailable = lines.length > 0 || words.length > 0;
        result.lines = lines; result.words = words;
        if (lines.length === 0 && words.length === 0) return result;
        const items = [];
        for (const line of lines) {
            const text = (line.text || '').trim();
            if (!text) continue;
            if (line.confidence !== undefined && line.confidence < 5) continue;
            const bb = line.bbox || {};
            const x0 = Number(bb.x0) || 0, y0 = Number(bb.y0) || 0;
            const x1 = Number(bb.x1) || x0, y1 = Number(bb.y1) || y0;
            if ((x1 - x0) < 2 || (y1 - y0) < 2) continue;
            const pad = 2;
            items.push({
                type: 'general_text', typeLabel: '图片文字',
                value: text, rawValue: text,
                bbox: { x0: Math.max(0, x0-pad), y0: Math.max(0, y0-pad), x1: x1+pad, y1: y1+pad },
                rowBbox: { x0: Math.max(0, x0-pad), y0: Math.max(0, y0-pad), x1: x1+pad, y1: y1+pad },
                confidence: line.confidence || 0,
            });
        }
        result.items = items; result.hasText = items.length > 0;
        console.log('[全图文字检测] Tesseract.js 识别到 ' + items.length + ' 处文字');
    } catch (err) { result.error = err.message || '全图文字检测失败'; }
    return result;
}

/** 使用 PaddleOCR.js 识别（深度学习，招牌/路标识别率极高） */
async function detectWithPaddleOCR(imageSource) {
    if (!detectWithPaddleOCR._instancePromise) {
        detectWithPaddleOCR._instancePromise = (async () => {
            const timeout = new Promise((_, rej) =>
                setTimeout(() => rej(new Error('PaddleOCR.js 初始化超时（60秒）')), 60000));
            // 模型文件托管在项目本地 lib/models/（百度 BOS 源站无 CORS 头，浏览器跨域会被拦截）
            // 使用 PP-OCRv6_small：v5_mobile 对立体镂空招牌大字几乎检测不到，v6_small 实测可准确识别
            const createOcr = window.PaddleOCR.create({
                textDetectionModelName: 'PP-OCRv6_small_det',
                textDetectionModelAsset: { url: 'lib/models/PP-OCRv6_small_det_onnx_infer.tar' },
                textRecognitionModelName: 'PP-OCRv6_small_rec',
                textRecognitionModelAsset: { url: 'lib/models/PP-OCRv6_small_rec_onnx_infer.tar' },
                ortOptions: { backend: 'wasm' },
            });
            return await Promise.race([createOcr, timeout]);
        })();
    }
    let ocr;
    try {
        ocr = await detectWithPaddleOCR._instancePromise;
        console.log('[PaddleOCR] 初始化成功');
    } catch (e) {
        console.error('[PaddleOCR] 初始化失败:', e.message);
        return { success: false, error: 'PaddleOCR.js 初始化失败：' + e.message };
    }
    try {
        // 参数说明（实测调优）：
        //   textDetLimitSideLen 3000 —— 2448 会把大图压缩过度，导致"寺"这类大字漏检
        //   textRecScoreThresh 0.3   —— 默认阈值会丢弃低置信度但正确的字（"寺"仅 0.32）
        //   detThresh/boxThresh 降低 —— 提高弱对比文字的检出率
        const PARAMS = {
            textDetLimitSideLen: 3000,
            textDetThresh: 0.2,
            textDetBoxThresh: 0.3,
            textDetUnclipRatio: 2.0,
            textRecScoreThresh: 0.3,
        };

        const img = await toImageElement(imageSource);
        const W = img.naturalWidth, H = img.naturalHeight;
        const raw = [];
        console.log(`[PaddleOCR] 原图尺寸 ${W}x${H}`);

        // 保护罩：任何 predict 错误（不只 OOM）都自动缩小画布重试一次，
        // 扛住连续多图时 wasm 后端的内存波动/状态异常；识别逻辑和参数不变。
        async function predictWithGuard(sx, sy, sw, sh, side, params) {
            let cv = drawRegion(img, sx, sy, sw, sh, side);
            console.log(`[PaddleOCR] 识别区域 ${sx},${sy} ${sw}x${sh} -> 画布 ${cv.width}x${cv.height}`);
            try {
                const [p] = await ocr.predict(cv, params);
                return { items: p && p.items, scale: cv._scale };
            } catch (e) {
                const msg = String((e && e.message) || e);
                console.error(`[PaddleOCR] predict 失败（${msg.slice(0, 100)}），缩小尺寸重试`);
                const side2 = Math.max(1000, Math.round(side * 0.65));
                const cv2 = drawRegion(img, sx, sy, sw, sh, side2);
                console.log(`[PaddleOCR] 重试画布 ${cv2.width}x${cv2.height}`);
                const [p2] = await ocr.predict(cv2, params);
                return { items: p2 && p2.items, scale: cv2._scale };
            }
        }

        // 第一遍：整图识别（大字靠这一遍）
        const r1 = await predictWithGuard(0, 0, W, H, 3000, PARAMS);
        console.log('[PaddleOCR] 第一遍整图识别：' + (r1.items ? r1.items.length : 0) + ' 处文字');
        collectTextItems(raw, r1.items, 0, 0, r1.scale);

        // 第二遍：2×2 重叠分块（首遍结果稀疏时说明存在小字/弱对比文字）
        // 分块会把落款、标注、门牌等小字放大，整图分辨率下这些字只有几十像素高
        if (raw.length < 10) {
            const cols = 2, rows = 2, overlap = 0.3;
            const tw = Math.round(W * (1 + overlap) / cols);
            const th = Math.round(H * (1 + overlap) / rows);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const sx = Math.max(0, Math.min(W - tw, Math.round(c * (W - tw) / (cols - 1))));
                    const sy = Math.max(0, Math.min(H - th, Math.round(r * (H - th) / (rows - 1))));
                    const rp = await predictWithGuard(sx, sy, tw, th, 1800, Object.assign({}, PARAMS, { textDetLimitSideLen: 1800 }));
                    collectTextItems(raw, rp.items, sx, sy, rp.scale);
                }
            }
        }

        const imgArea = W * H;
        const items = dedupeTextItems(raw)
            .filter(t => {
                // 过滤明显误检的超大框：真实文字行面积不会超过图片的 12%
                // （大字招牌约占 7%，整个建筑立面/玻璃幕墙误检框会超过 15%）
                const bw = t.bbox.x1 - t.bbox.x0;
                const bh = t.bbox.y1 - t.bbox.y0;
                return (bw * bh) < imgArea * 0.12;
            })
            .map(t => {
            const pad = 3;
            const bbox = {
                x0: Math.max(0, t.bbox.x0 - pad), y0: Math.max(0, t.bbox.y0 - pad),
                x1: Math.min(W, t.bbox.x1 + pad), y1: Math.min(H, t.bbox.y1 + pad),
            };
            return {
                type: 'general_text', typeLabel: '图片文字',
                value: t.text, rawValue: t.text,
                bbox: bbox, rowBbox: bbox,
                confidence: Math.round(t.score * 100), poly: t.poly,
            };
        });

        if (items.length === 0) return { success: false };
        return { success: true, data: {
            hasText: true, items: items,
            lines: items.map(i => ({ text: i.value, confidence: i.confidence, bbox: i.bbox })),
            words: items.map(i => ({ text: i.value, confidence: i.confidence, bbox: i.bbox })),
            ocrAvailable: true,
        }};
    } catch (e) {
        console.error('[PaddleOCR] 识别最终失败:', e && e.message, e);
        // 实例可能已损坏，清掉单例缓存，下一张图会重新初始化 OCR 引擎
        detectWithPaddleOCR._instancePromise = null;
        return { success: false, error: 'PaddleOCR.js 识别失败：' + (e && e.message) };
    }
}

/** 把 File/Blob/Image 统一转成 <img>（分块绘制需要图片源，且 predict 会 detach ImageBitmap） */
async function toImageElement(source) {
    if (source && source.naturalWidth) return source;
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.src = url;
    try { await img.decode(); }
    finally { URL.revokeObjectURL(url); }
    return img;
}

/** 从原图截取一块区域并缩放到指定长边，返回 canvas（附 _scale：画布像素 / 原图像素） */
function drawRegion(img, sx, sy, sw, sh, side) {
    // 最多放大 2 倍，避免小区域被过度放大导致耗时飙升
    const scale = Math.min(2, side / Math.max(sw, sh));
    const cv = document.createElement('canvas');
    cv.width = Math.round(sw * scale);
    cv.height = Math.round(sh * scale);
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    cv._scale = scale;
    return cv;
}

/** 把某次识别的结果换算回原图坐标系，追加到 raw 列表 */
function collectTextItems(raw, items, offsetX, offsetY, scale) {
    for (const it of items || []) {
        const text = (it.text || '').trim();
        if (!text || !it.poly || it.poly.length < 4) continue;
        const poly = it.poly.map(p => [offsetX + p[0] / scale, offsetY + p[1] / scale]);
        const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
        raw.push({
            text: text, score: it.score || 0, poly: poly,
            bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        });
    }
}

/** 多遍识别结果去重（同一行文字会被整图和分块各识别一次），保留置信度最高的
 *  判定为重复的两种情况：
 *    1) 两个框几乎重合（IoU > 0.5）——同一处文字被两遍各识别一次
 *    2) 文字相同且重叠超过较小框的 30%——同一个字被分块识别成大小两个框
 *  不能用"重叠/最小框面积"一刀切：相邻单字（如"靈"与"寺"）的框本就部分相交，
 *  那样会把"寺"误判成重复而丢弃
 */
function dedupeTextItems(raw) {
    const area = b => Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    const interArea = (a, b) => {
        const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
        const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
        return iw * ih;
    };
    const isDuplicate = (a, b) => {
        const inter = interArea(a.bbox, b.bbox);
        if (inter <= 0) return false;
        const iou = inter / (area(a.bbox) + area(b.bbox) - inter);
        if (iou > 0.5) return true;
        return a.text === b.text && inter / Math.min(area(a.bbox), area(b.bbox)) > 0.3;
    };
    const kept = [];
    for (const it of raw.slice().sort((a, b) => b.score - a.score)) {
        if (!kept.some(k => isDuplicate(k, it))) kept.push(it);
    }
    // 按从上到下、从左到右排序，方便阅读
    kept.sort((a, b) => (Math.round(a.bbox.y0 / 20) - Math.round(b.bbox.y0 / 20)) || (a.bbox.x0 - b.bbox.x0));
    return kept;
}


window.analyzeImage = analyzeImage;
