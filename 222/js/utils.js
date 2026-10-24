/**
 * utils.js — 通用工具函数
 *
 * 本模块提供项目中多处会用到的通用工具，其他模块可以直接调用这里的函数。
 * 所有函数都是纯函数（输入→输出，不修改外部状态），方便调试和测试。
 */

// ============================================================
// 文件类型判断
// ============================================================

/**
 * 根据文件扩展名判断文件类型
 * @param {File|string} file - 文件对象或文件名字符串
 * @returns {string} - 类型标识："docx" / "pdf" / "image" / "unknown"
 *
 * 使用方式：
 *   const type = getFileType(file);
 *   if (type === "docx") { ... }
 */
function getFileType(file) {
    // 如果传的是 File 对象，取它的 name 属性；否则直接当字符串用
    const name = typeof file === "string" ? file : file.name;
    // 转小写后取最后一个点后面的部分作为扩展名
    const ext = name.toLowerCase().split(".").pop();

    // docx / xlsx / pptx / doc 格式
    if (ext === "docx") return "docx";
    if (ext === "xlsx" || ext === "xlsm") return "xlsx";
    if (ext === "pptx" || ext === "pptm" || ext === "ppsx") return "pptx";
    if (ext === "doc") return "doc";   // 旧版二进制 Word，只查元数据
    // pdf 格式
    if (ext === "pdf") return "pdf";
    // 常见图片格式
    if (["jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp", "heic"].includes(ext)) return "image";
    // 都不认识就返回 unknown
    return "unknown";
}

// ============================================================
// 格式化工具
// ============================================================

/**
 * 把字节数格式化成人类可读的大小（如 "1.2 MB"）
 * @param {number} bytes - 字节数
 * @returns {string} - 格式化后的字符串
 *
 * 使用方式：
 *   formatBytes(1024) → "1.0 KB"
 */
function formatBytes(bytes) {
    // 0 字节直接返回
    if (bytes === 0) return "0 B";
    // 单位列表，从大到小排
    const units = ["B", "KB", "MB", "GB", "TB"];
    // 计算应该用哪个单位（每 1024 进一级）
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    // 保留 1 位小数 + 单位
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

/**
 * 把日期字符串格式化成 "YYYY-MM-DD HH:mm:ss"
 * @param {string|Date} date - 日期字符串或 Date 对象
 * @returns {string} - 格式化后的日期
 *
 * 使用方式：
 *   formatDate("2024-01-15T10:30:00Z") → "2024-01-15 18:30:00"
 */
function formatDate(date) {
    // 如果不是 Date 对象，先转成 Date
    const d = date instanceof Date ? date : new Date(date);
    // 如果日期无效，返回空字符串
    if (isNaN(d.getTime())) return "";
    // 补零函数：5 → "05"
    const pad = (n) => String(n).padStart(2, "0");
    // 拼接成 YYYY-MM-DD HH:mm:ss
    return (
        d.getFullYear() + "-" +
        pad(d.getMonth() + 1) + "-" +
        pad(d.getDate()) + " " +
        pad(d.getHours()) + ":" +
        pad(d.getMinutes()) + ":" +
        pad(d.getSeconds())
    );
}

// ============================================================
// 文件读取工具
// ============================================================

/**
 * 把 File 对象读成 ArrayBuffer（二进制数据）
 * @param {File} file - 浏览器文件对象
 * @returns {Promise<ArrayBuffer>} - 二进制数据
 *
 * 使用方式：
 *   const buffer = await readFileAsArrayBuffer(file);
 */
function readFileAsArrayBuffer(file) {
    // 返回一个 Promise，用 FileReader 异步读取
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        // 读取成功时触发
        reader.onload = () => resolve(reader.result);
        // 读取失败时触发
        reader.onerror = () => reject(reader.error);
        // 开始读取，结果类型是 ArrayBuffer
        reader.readAsArrayBuffer(file);
    });
}

/**
 * 把 File 对象读成文本字符串
 * @param {File} file - 浏览器文件对象
 * @returns {Promise<string>} - 文本内容
 *
 * 使用方式：
 *   const text = await readFileAsText(file);
 */
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        // 按 UTF-8 读取文本
        reader.readAsText(file, "UTF-8");
    });
}

// ============================================================
// DOM 操作工具
// ============================================================

/**
 * 简写版的 document.querySelector
 * @param {string} selector - CSS 选择器
 * @param {HTMLElement} [parent=document] - 父元素，默认从 document 找
 * @returns {HTMLElement|null} - 找到的元素
 *
 * 使用方式：
 *   const btn = $("#submit-btn");
 */
function $(selector, parent = document) {
    return parent.querySelector(selector);
}

/**
 * 简写版的 document.querySelectorAll，返回真数组
 * @param {string} selector - CSS 选择器
 * @param {HTMLElement} [parent=document] - 父元素
 * @returns {HTMLElement[]} - 找到的元素数组
 *
 * 使用方式：
 *   const items = $$(".list-item");
 *   items.forEach(item => ...);
 */
function $$(selector, parent = document) {
    // querySelectorAll 返回的是 NodeList，转成真数组方便用 forEach/map 等
    return Array.from(parent.querySelectorAll(selector));
}

/**
 * 创建一个 HTML 元素，并设置属性和内容
 * @param {string} tag - 标签名，如 "div"
 * @param {Object} [attrs={}] - 属性对象，如 { class: "box", id: "a1" }
 * @param {string|HTMLElement|Array} [children] - 子内容（文本、元素或数组）
 * @returns {HTMLElement} - 创建好的元素
 *
 * 使用方式：
 *   const div = createEl("div", { class: "card" }, "hello");
 *   document.body.appendChild(div);
 */
function createEl(tag, attrs = {}, children) {
    // 创建元素
    const el = document.createElement(tag);
    // 遍历属性对象，逐一设置
    for (const [key, value] of Object.entries(attrs)) {
        // class 特殊处理，用 className
        if (key === "class") {
            el.className = value;
        }
        // style 传对象的话，展开到 el.style 上
        else if (key === "style" && typeof value === "object") {
            Object.assign(el.style, value);
        }
        // 以 on 开头的是事件，用 addEventListener
        else if (key.startsWith("on") && typeof value === "function") {
            el.addEventListener(key.slice(2).toLowerCase(), value);
        }
        // 其他普通属性，用 setAttribute
        else {
            el.setAttribute(key, value);
        }
    }
    // 处理子内容
    if (children != null) {
        // 如果是数组，递归添加每个子元素
        if (Array.isArray(children)) {
            children.forEach(child => el.appendChild(
                // 字符串就创建文本节点，否则直接追加
                typeof child === "string" ? document.createTextNode(child) : child
            ));
        }
        // 如果是字符串，创建文本节点
        else if (typeof children === "string") {
            el.textContent = children;
        }
        // 如果是元素，直接追加
        else {
            el.appendChild(children);
        }
    }
    return el;
}

// ============================================================
// 安全转义
// ============================================================

/**
 * 把字符串中的 HTML 特殊字符转义，防止 XSS
 * @param {string} str - 原始字符串
 * @returns {string} - 转义后的字符串
 *
 * 使用方式：
 *   const safe = escapeHtml(userInput);
 *   div.innerHTML = safe;
 */
function escapeHtml(str) {
    // 处理 null/undefined
    if (str == null) return "";
    const s = String(str);
    // 手动替换所有 HTML 特殊字符（比 textContent 方式更明确，也能正确处理引号）
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/\//g, "&#x2F;");
}

/**
 * HTML 属性值转义，防止属性注入型 XSS
 * 用于将用户可控内容放到 HTML 属性值中（如 title、download、data-* 等）
 * @param {string} str - 原始字符串
 * @returns {string} - 转义后的字符串
 */
function escapeAttr(str) {
    if (str == null) return "";
    const s = String(str);
    return s
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/`/g, "&#96;")
        .replace(/\n/g, "&#10;")
        .replace(/\r/g, "&#13;")
        .replace(/\t/g, "&#9;");
}

/**
 * 截断字符串到指定长度（防止超长内容撑爆页面或占用过多内存）
 * @param {string} str - 原始字符串
 * @param {number} maxLen - 最大长度
 * @returns {string} - 截断后的字符串
 */
function truncate(str, maxLen = 500) {
    if (str == null) return "";
    const s = String(str);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "...";
}

// ============================================================
// 安全与防护工具
// ============================================================

/**
 * 为 Promise 添加超时限制，防止长时间操作卡死浏览器
 * @param {Promise} promise - 原始 Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} [message] - 超时时的错误信息
 * @returns {Promise} - 带超时的 Promise
 */
function withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(message || `操作超时（${timeoutMs}ms）`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

/**
 * 文件大小限制配置（字节）
 * 防止超大文件或压缩炸弹导致浏览器内存溢出
 */
const FILE_SIZE_LIMITS = {
    docx: 50 * 1024 * 1024,      // DOCX 最大 50MB
    pdf: 100 * 1024 * 1024,      // PDF 最大 100MB
    image: 20 * 1024 * 1024,     // 图片最大 20MB
    totalBatch: 200 * 1024 * 1024, // 批量总大小 200MB
};

/**
 * 解析超时配置（毫秒）
 */
const PARSE_TIMEOUTS = {
    docx: 30 * 1000,     // DOCX 解析 30 秒超时
    pdf: 60 * 1000,      // PDF 解析 60 秒超时
    image: 15 * 1000,    // 图片解析 15 秒超时
};

/**
 * ZIP 压缩炸弹检测阈值
 * 解压后大小 / 压缩前大小 超过此比例则认为是压缩炸弹
 */
const ZIP_BOMB_RATIO = 100;          // 压缩比超过 100 倍告警
const ZIP_BOMB_MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 最大解压 200MB
const ZIP_MAX_ENTRIES = 10000;       // ZIP 内最多文件数（防止条目炸弹）

// ============================================================
// 文件安全安检（guardFile）
// ============================================================

/**
 * 单文件前置安检：检查文件类型 + 文件大小
 * 在解析文件前先调用，尽早拒绝不合法文件，防止 DoS
 * @param {File} file - 要检查的文件
 * @returns {{ pass: boolean, reason: string, fileType: string }}
 *   - pass: 是否通过安检
 *   - reason: 不通过的原因（通过时为空字符串）
 *   - fileType: 检测出的文件类型
 */
function guardFile(file) {
    // 1. 检查文件类型
    const fileType = getFileType(file);
    if (fileType === "unknown") {
        return { pass: false, reason: "不支持的文件格式", fileType };
    }

    // 2. 检查文件大小
    const limits = FILE_SIZE_LIMITS;
    const maxSize = limits[fileType];
    if (maxSize && file.size > maxSize) {
        return {
            pass: false,
            reason: `文件过大（${formatBytes(file.size)}），最大支持 ${formatBytes(maxSize)}`,
            fileType,
        };
    }

    // 3. 空文件检查
    if (file.size === 0) {
        return { pass: false, reason: "文件为空", fileType };
    }

    return { pass: true, reason: "", fileType };
}

/**
 * 批量文件前置安检：检查总大小 + 逐个检查
 * @param {File[]} files - 文件数组
 * @returns {{ pass: boolean, reason: string, validFiles: File[] }}
 *   - pass: 是否整体通过
 *   - reason: 不通过的原因
 *   - validFiles: 过滤后的有效文件列表
 */
function guardBatchFiles(files) {
    const validFiles = [];
    const errors = [];

    // 1. 检查批量总大小
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > FILE_SIZE_LIMITS.totalBatch) {
        return {
            pass: false,
            reason: `批量文件总大小过大（${formatBytes(totalSize)}），最大支持 ${formatBytes(FILE_SIZE_LIMITS.totalBatch)}`,
            validFiles: [],
        };
    }

    // 2. 逐个检查
    for (const file of files) {
        const check = guardFile(file);
        if (check.pass) {
            validFiles.push(file);
        } else {
            errors.push(`${file.name}: ${check.reason}`);
        }
    }

    if (validFiles.length === 0) {
        return {
            pass: false,
            reason: errors.length > 0 ? errors.join("；") : "没有有效的文件",
            validFiles: [],
        };
    }

    return { pass: true, reason: "", validFiles };
}

// ============================================================
// 导出到全局（因为不用模块化打包工具，直接挂到 window 上）
// ============================================================
window.Utils = {
    getFileType,
    formatBytes,
    formatDate,
    readFileAsArrayBuffer,
    readFileAsText,
    $,
    $$,
    createEl,
    escapeHtml,
    escapeAttr,
    truncate,
    withTimeout,
    FILE_SIZE_LIMITS,
    PARSE_TIMEOUTS,
    ZIP_BOMB_RATIO,
    ZIP_BOMB_MAX_UNCOMPRESSED,
    ZIP_MAX_ENTRIES,
    guardFile,
    guardBatchFiles,
};
