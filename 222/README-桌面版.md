# 残影 · 外发文件二次泄露体检台（桌面版）

纯前端网页检测 Word / 图片 / PDF 的隐性泄露（修订 / 批注 / 元数据 / GPS /
缩略图不一致 / PDF 假黑框 / 隐藏文字 / 批注），一键清洗后输出脱敏文件。
本工程把它包装成**桌面应用**，双击即用、完全离线。

## 两种运行方式

### A. 网页版（零安装，双击即用）
直接双击 `index.html`，用浏览器打开即可。全离线，所有库都在 `lib/`。

### B. 桌面版（Electron，.exe / .dmg / AppImage）

```bash
npm install        # 首次安装依赖（electron 等）
npm start          # 以桌面窗口运行
npm run dev        # 调试模式（自动打开开发者工具）
```

**打包成安装包**（需在对应系统上执行）：

```bash
npm run build:win     # Windows → 生成 .exe（nsis 安装版 + portable 免安装版）
npm run build:mac     # macOS → .dmg
npm run build:linux   # Linux → AppImage
```

打包产物输出到 `dist/` 目录。

> Windows 打包说明：`.exe` 需要在 **Windows 环境**（或 Windows CI）里执行
> `npm run build:win`；在 Linux 上交叉打包 Windows 需要 wine 等额外环境，较麻烦。
> 未做代码签名时，首次运行 Windows 可能弹 SmartScreen 提示，点"更多信息→仍要运行"即可。

### C. 云端 GitHub Actions 打包 Windows .exe（推荐，无需本地装环境）

仓库已内置 `.github/workflows/build-win.yml`，推到 GitHub 后自动在云端 Windows 上编译出 `.exe`，下载即用：

1. **建仓库**：在 GitHub 新建一个空仓库（如 `residual-shadow`），把本目录所有文件推上去（保持目录结构）。
2. **触发**：推送到 `main` 分支即自动触发；或在仓库页 **Actions → 选中 `Build Windows exe` → Run workflow** 手动触发。
3. **下载**：跑完后进 **Actions** 页面，点本次运行，底部 **Artifacts → `residual-shadow-exe`** 下载，里面是 `残影体检台-1.0.0-x64.exe`（含安装版 + portable 免安装版）。
4. 用国内镜像加速依赖：workflow 已带 `ELECTRON_MIRROR` 指向 npmmirror。

> 提示：上传时**不要**包含 `node_modules/` 和 `dist/`（`.gitignore` 已自动排除）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `electron-main.js` | Electron 主进程：开窗口、加载页面、原生"另存为"保存清洗结果 |
| `preload.js` | 安全桥接：只暴露 `saveFile` 一个受限接口（contextBridge 隔离） |
| `index.html` + `js/` | 原有纯前端逻辑，原样复用（检测 + 评分 + 清洗） |
| `lib/` | 本地化第三方库（jszip / pdf.js / pdf-lib / exifr），全离线 |

## 安全性
- **文件不出本机**：无后端、无上传、无任何网络请求。
- 桌面版用 `contextIsolation:true` + `nodeIntegration:false`，页面拿不到 Node 权限，
  只通过 preload 暴露的 `saveFile` 保存文件。
- 清洗结果走系统原生"另存为"对话框，直接写磁盘。
- 前端已开启 **CSP（Content-Security-Policy）**，作为 XSS 纵深防御。
- 所有用户输入内容均做 HTML 转义，防止 XSS。
- 文件大小 / ZIP 压缩比 / PDF 页数 / 图片尺寸 均设上限，防止浏览器崩溃（DoS）。

## 第三方库版本（便于 CVE 追踪升级）

所有前端库均已本地化存放于 `lib/` 目录，全离线可用。

| 库 | 版本 | 用途 | 备注 |
|---|---|---|---|
| JSZip | **v3.10.1** | DOCX 解压/打包 | 文件头部可查：`JSZip v3.10.1` |
| pdf.js | **v3.11.174** | PDF 解析、渲染 | `lib/pdf.min.js` + `pdf.worker.min.js` |
| pdf-lib | **约 v1.17.x**（待确认） | PDF 元数据清洗、重渲染打包 | `lib/pdf-lib.min.js`（约 513KB，UMD 构建） |
| exifr | **约 v7.x**（待确认） | 图片 EXIF 元数据读取 | `lib/exifr.min.js`（约 74KB，完整版构建） |

> **版本确认方法**：打开 `index.html`，按 **F12** 打开开发者工具，切换到 **Console（控制台）** 标签，依次输入以下命令查看：
>
> ```javascript
> // 1. JSZip 版本
> JSZip.version
>
> // 2. pdf.js 版本
> pdfjsLib.version
>
> // 3. pdf-lib 版本（UMD 构建未直接暴露 version 属性）
> //    可通过文件大小 + npm 上各版本发布记录对照确认
>
> // 4. exifr 版本（未直接暴露 version 属性）
> //    可先上传一张图片触发加载，再通过 Object.keys(exifr) 查看导出的属性
> ```
>
> **pdf-lib / exifr 版本确认技巧**：
> - 在文件资源管理器中右键查看 `lib/pdf-lib.min.js` 和 `lib/exifr.min.js` 的文件大小
> - 到 [npmjs.com](https://www.npmjs.com/) 搜索库名，查看各历史版本的发布时间和构建大小，对照匹配
> - 或者查看最初下载这些库的来源（CDN 链接、npm 包等）
>
> 如果某个命令报错（如 `exifr is not defined`），说明该库要等用到时才会加载，
> 可以先上传一张图片触发 exifr 加载，再重新输入命令。
>
> **升级建议**：定期关注各库的 CVE 公告，如有高危漏洞需升级对应文件。
> 可在以下网站搜索库名查询：
> - NVD（美国国家漏洞数据库）：<https://nvd.nist.gov/vuln/search>
> - CVE Details：<https://www.cvedetails.com/>
> - GitHub Security Advisories：<https://github.com/advisories>
