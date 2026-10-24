/**
 * analyze-xlsx.js — Excel(.xlsx/.xlsm) 二次泄露检测
 *
 * xlsx 本质是 zip 包，可复用 JSZip 解压，检测以下泄露点：
 *   1. 隐藏行/隐藏列（含敏感数据但被隐藏）
 *   2. 白字/同色文字（与背景同色，肉眼不可见但数据在）
 *   3. 单元格批注（作者 + 内容）
 *   4. 隐藏工作表（sheet state="hidden"）
 *   5. 元数据（作者/公司/最后修改者）
 *
 * 返回统一结构：
 * {
 *   fileType: "xlsx",
 *   metadata: { author, company, lastModifiedBy, hasSensitive },
 *   hidden:   { count, hasHidden, items: [{ sheet, type, text }] },
 *   comments: { count, hasComments, items: [{ sheet, cell, author, text }] },
 * }
 */

async function analyzeXlsx(file) {
    const result = {
        fileType: "xlsx",
        metadata: { author: "", company: "", lastModifiedBy: "", hasSensitive: false },
        hidden: { count: 0, hasHidden: false, items: [] },
        comments: { count: 0, hasComments: false, items: [] },
    };

    // Excel 兼容读文本（读单个 zip 条目）
    async function readEntry(zip, path) {
        const f = zip.file(path);
        if (!f) return null;
        try { return await f.async("string"); } catch { return null; }
    }

    // 文本去空白
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    try {
        const zip = await JSZip.loadAsync(file);

        // ---- 1. 元数据 docProps/core.xml ----
        const coreXml = await readEntry(zip, "docProps/core.xml");
        if (coreXml) {
            const doc = new DOMParser().parseFromString(coreXml, "text/xml");
            const get = (tag) => {
                const el = doc.getElementsByTagName(tag)[0];
                return el ? clean(el.textContent) : "";
            };
            result.metadata.author = get("dc:creator");
            result.metadata.lastModifiedBy = get("cp:lastModifiedBy");
            result.metadata.company = get("cp:category") || "";
            // company 常在 docProps/custom.xml 或 cp: 下没有，尝试 app.xml
            if (!result.metadata.company) {
                const appXml = await readEntry(zip, "docProps/app.xml");
                if (appXml) {
                    const ad = new DOMParser().parseFromString(appXml, "text/xml");
                    const c = ad.getElementsByTagName("Company")[0];
                    if (c) result.metadata.company = clean(c.textContent);
                }
            }
            if (result.metadata.author || result.metadata.company || result.metadata.lastModifiedBy) {
                result.metadata.hasSensitive = true;
            }
        }

        // ---- 2. sharedStrings.xml（把单元格字符串索引解析成文字） ----
        const shared = [];
        const ssXml = await readEntry(zip, "xl/sharedStrings.xml");
        if (ssXml) {
            const sd = new DOMParser().parseFromString(ssXml, "text/xml");
            const sis = sd.getElementsByTagName("si");
            for (let i = 0; i < sis.length; i++) {
                let txt = "";
                const ts = sis[i].getElementsByTagName("t");
                for (let j = 0; j < ts.length; j++) txt += ts[j].textContent;
                shared.push(clean(txt));
            }
        }

        // ---- 3. styles.xml：字体颜色 / 填充色映射（用于白字/同色检测） ----
        // 注意：单元格的 s 索引映射到 <cellXfs>（第二个 xf 表），不是工作表的 xf
        let fonts = [], fills = [], cellXfs = [];
        const stXml = await readEntry(zip, "xl/styles.xml");
        if (stXml) {
            const std = new DOMParser().parseFromString(stXml, "text/xml");
            const fontNodes = std.getElementsByTagName("font");
            for (let i = 0; i < fontNodes.length; i++) {
                const colorEl = fontNodes[i].getElementsByTagName("color")[0];
                // 颜色可能带 ARGB 前缀（00 或 FF），统一取后 6 位
                fonts.push(colorEl ? (colorEl.getAttribute("rgb") || "").slice(-6).toUpperCase() : "");
            }
            const fillNodes = std.getElementsByTagName("fill");
            for (let i = 0; i < fillNodes.length; i++) {
                const bg = fillNodes[i].getElementsByTagName("bgColor")[0]
                    || fillNodes[i].getElementsByTagName("fgColor")[0];
                fills.push(bg ? (bg.getAttribute("rgb") || "").slice(-6).toUpperCase() : "");
            }
            // cellXfs：取 <cellXfs> 元素的直接子 <xf>
            const cellXfsNode = std.getElementsByTagName("cellXfs")[0];
            if (cellXfsNode) {
                const xfChildren = cellXfsNode.getElementsByTagName("xf");
                for (let i = 0; i < xfChildren.length; i++) {
                    cellXfs.push({
                        fontId: parseInt(xfChildren[i].getAttribute("fontId"), 10),
                        fillId: parseInt(xfChildren[i].getAttribute("fillId"), 10),
                    });
                }
            }
        }

        // ---- 4. workbook.xml：隐藏工作表 ----
        const wbXml = await readEntry(zip, "xl/workbook.xml");
        const sheetNameByRel = {};
        if (wbXml) {
            const wd = new DOMParser().parseFromString(wbXml, "text/xml");
            const sheets = wd.getElementsByTagName("sheet");
            for (let i = 0; i < sheets.length; i++) {
                const s = sheets[i];
                const name = clean(s.getAttribute("name"));
                const state = s.getAttribute("state") || "visible";
                if (state === "hidden" || state === "veryHidden") {
                    result.hidden.count++;
                    result.hidden.hasHidden = true;
                    result.hidden.items.push({ sheet: name, type: "隐藏工作表", text: `工作表「${name}」被隐藏（可能含敏感数据）` });
                }
            }
            // 记录 sheet 顺序：sheetN → 名称
            const relIdToName = {};
            const sheetNodes = wd.getElementsByTagName("sheet");
            let idx = 1;
            for (let i = 0; i < sheetNodes.length; i++) {
                const rid = sheetNodes[i].getAttribute("r:id");
                if (rid) relIdToName[rid] = clean(sheetNodes[i].getAttribute("name"));
            }
            // 读 xl/_rels/workbook.xml.rels 映射 rId → sheetN.xml
            const relXml = await readEntry(zip, "xl/_rels/workbook.xml.rels");
            if (relXml) {
                const rd = new DOMParser().parseFromString(relXml, "text/xml");
                const rels = rd.getElementsByTagName("Relationship");
                for (let i = 0; i < rels.length; i++) {
                    const r = rels[i];
                    const rid = r.getAttribute("Id");
                    const target = r.getAttribute("Target") || "";
                    const m = target.match(/worksheets\/sheet(\d+)\.xml$/);
                    if (m && relIdToName[rid]) {
                        sheetNameByRel[parseInt(m[1], 10)] = relIdToName[rid];
                    }
                }
            }
        }

        // ---- 5. 遍历每个工作表：隐藏行列 + 白字/同色文字 ----
        const MAX_SHEETS = 50;   // 防超多 sheet 拖垮
        for (let n = 1; n <= MAX_SHEETS; n++) {
            const sheetXml = await readEntry(zip, `xl/worksheets/sheet${n}.xml`);
            if (!sheetXml) continue;
            const sheetName = sheetNameByRel[n] || `Sheet${n}`;
            const sd = new DOMParser().parseFromString(sheetXml, "text/xml");

            // 隐藏列
            const cols = sd.getElementsByTagName("col");
            for (let i = 0; i < cols.length; i++) {
                const c = cols[i];
                if (c.getAttribute("hidden") === "1" || c.getAttribute("hidden") === "true") {
                    const min = c.getAttribute("min"), max = c.getAttribute("max");
                    result.hidden.count++;
                    result.hidden.hasHidden = true;
                    result.hidden.items.push({ sheet: sheetName, type: "隐藏列", text: `工作表「${sheetName}」有 ${min}${max && max !== min ? "~" + max : ""} 列被隐藏` });
                }
            }

            // 隐藏行 + 单元格
            const rows = sd.getElementsByTagName("row");
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowNum = row.getAttribute("r") || "";
                if (row.getAttribute("hidden") === "1" || row.getAttribute("hidden") === "true") {
                    result.hidden.count++;
                    result.hidden.hasHidden = true;
                    result.hidden.items.push({ sheet: sheetName, type: "隐藏行", text: `工作表「${sheetName}」第 ${rowNum} 行被隐藏` });
                }
                // 该行内单元格：检测白字/同色
                const cells = row.getElementsByTagName("c");
                for (let j = 0; j < cells.length; j++) {
                    const cell = cells[j];
                    const ref = cell.getAttribute("r") || "";
                    const styleIdx = parseInt(cell.getAttribute("s"), 10);
                    // 取字体/填充色（用 styles.xml 的 cellXfs 解析）
                    let fontColor = "", fillColor = "";
                    if (!isNaN(styleIdx) && cellXfs[styleIdx]) {
                        const xf = cellXfs[styleIdx];
                        if (!isNaN(xf.fontId) && fonts[xf.fontId]) fontColor = fonts[xf.fontId];
                        if (!isNaN(xf.fillId) && fills[xf.fillId]) fillColor = fills[xf.fillId];
                    }
                    // 读取单元格值
                    let val = "";
                    const t = cell.getAttribute("t");
                    const v = cell.getElementsByTagName("v")[0];
                    if (t === "s" && v) {
                        const si = parseInt(v.textContent, 10);
                        if (!isNaN(si) && shared[si] !== undefined) val = shared[si];
                    } else if (t === "inlineStr") {
                        const is = cell.getElementsByTagName("t");
                        for (let k = 0; k < is.length; k++) val += is[k].textContent;
                        val = clean(val);
                    } else if (v) {
                        val = clean(v.textContent);
                    }
                    // 白字/同色判断：字体为白色，或字体色==填充色（同为纯色）
                    const isWhiteFont = fontColor === "FFFFFF";
                    const isSameAsBg = fontColor && fillColor && fontColor === fillColor;
                    if ((isWhiteFont || isSameAsBg) && val && val.length > 0) {
                        result.hidden.count++;
                        result.hidden.hasHidden = true;
                        result.hidden.items.push({
                            sheet: sheetName,
                            type: isWhiteFont ? "白字隐藏" : "同色隐藏",
                            text: `「${sheetName}」单元格 ${ref}：${val.slice(0, 40)}${val.length > 40 ? "…" : ""}`,
                        });
                    }
                }
            }
        }

        // ---- 6. 单元格批注 xl/comments/commentN.xml（或 xl/commentsN.xml） ----
        for (let n = 1; n <= 10; n++) {
            const cmXml = await readEntry(zip, `xl/comments/comment${n}.xml`) || await readEntry(zip, `xl/comments${n}.xml`);
            if (!cmXml) continue;
            const cd = new DOMParser().parseFromString(cmXml, "text/xml");
            const authors = [];
            const authorNodes = cd.getElementsByTagName("author");
            for (let i = 0; i < authorNodes.length; i++) authors.push(clean(authorNodes[i].textContent));
            const comments = cd.getElementsByTagName("comment");
            for (let i = 0; i < comments.length; i++) {
                const cm = comments[i];
                const ref = cm.getAttribute("ref") || "";
                const authorId = parseInt(cm.getAttribute("authorId"), 10);
                const author = (!isNaN(authorId) && authors[authorId]) ? authors[authorId] : "未知";
                let text = "";
                const ts = cm.getElementsByTagName("t");
                for (let k = 0; k < ts.length; k++) text += ts[k].textContent;
                text = clean(text);
                if (author || text) {
                    result.comments.count++;
                    result.comments.hasComments = true;
                    result.comments.items.push({ sheet: "", cell: ref, author, text: text.slice(0, 100) });
                }
            }
            break; // 通常只有一个 comments1.xml
        }

    } catch (err) {
        result.error = err.message;
    }

    return result;
}

window.analyzeXlsx = analyzeXlsx;
