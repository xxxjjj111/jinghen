/**
 * electron-main.js — 残影 · 外发文件二次泄露体检台（桌面版）主进程
 *
 * 作用：开一个桌面窗口，加载现有的 index.html（纯前端页面原样复用），
 * 并把"下载清洗结果"接到原生"另存为"对话框。
 *
 * 运行：
 *   npm install        # 安装 electron 等依赖
 *   npm start          # 本地以桌面窗口运行
 *   打包（需在对应系统上执行）：
 *     npm run build:win   # Windows .exe
 *     npm run build:mac   # macOS .dmg
 *     npm run build:linux # Linux AppImage
 */
const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

let win = null;
let server = null;

// 启动本地 HTTP 服务器（PaddleOCR.js 需要 HTTP 协议才能加载模型文件，file:// 不行）
function startLocalServer() {
    return new Promise((resolve) => {
        const port = 18923;
        server = http.createServer((req, res) => {
            let filePath = req.url.split("?")[0];
            if (filePath === "/") filePath = "/index.html";
            const fullPath = path.join(__dirname, filePath);
            fs.readFile(fullPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end("Not found");
                    return;
                }
                const ext = path.extname(fullPath).toLowerCase();
                const mime = {
                    ".html": "text/html",
                    ".js": "application/javascript",
                    ".css": "text/css",
                    ".json": "application/json",
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".gif": "image/gif",
                    ".svg": "image/svg+xml",
                    ".tar": "application/x-tar",
                    ".wasm": "application/wasm",
                    ".mjs": "application/javascript",
                }[ext] || "application/octet-stream";
                res.writeHead(200, {
                    "Content-Type": mime,
                    // 跨源隔离：让 SharedArrayBuffer 可用，PaddleOCR 多线程加速
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                });
                res.end(data);
            });
        });
        server.listen(port, () => resolve(port));
    });
}

async function createWindow() {
    const port = await startLocalServer();

    win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: "#0d1117",
        title: "净痕 · 外发文件二次泄露体检台",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });

    // 用 HTTP 协议加载页面（PaddleOCR.js 需要 HTTP 协议才能加载模型文件）
    win.loadURL(`http://localhost:${port}/index.html`);

    // 阻止页面被导航走：拖文件到窗口时 Electron 默认会把文件当 URL 打开，
    // 这里拦截掉，让拖拽事件能正常落在页面上
    win.webContents.on("will-navigate", (e, url) => {
        e.preventDefault();
    });

    // 自动打开开发者工具（调试用）
    win.webContents.openDevTools({ mode: "detach" });

    win.on("closed", () => { win = null; });
}

// —— 保存清洗后的文件：弹原生"另存为"对话框，写入磁盘 ——
ipcMain.handle("save-file", async (event, data, filename) => {
    if (!win) return { canceled: true };
    const opts = { defaultPath: filename || "cleaned.pdf" };
    // 根据扩展名给个默认过滤器
    const ext = (filename || "").split(".").pop().toLowerCase();
    if (ext === "docx") opts.filters = [{ name: "Word 文档", extensions: ["docx"] }];
    else if (ext === "pdf") opts.filters = [{ name: "PDF", extensions: ["pdf"] }];
    else if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) opts.filters = [{ name: "图片", extensions: [ext] }];

    const { canceled, filePath } = await dialog.showSaveDialog(win, opts);
    if (canceled || !filePath) return { canceled: true };
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return { canceled: false, filePath };
});

app.whenReady().then(() => {
    // 极简窗口，去掉默认菜单（保留最基础的退出逻辑）
    Menu.setApplicationMenu(null);
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
