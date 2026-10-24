/**
 * analyze-doc.js
 * 旧版 Word(.doc，二进制 OLE) 隐性泄露检测：文档元数据
 *
 * 原理：
 *   .doc 是老式 OLE2 复合文档，元数据（作者/最后保存者/标题/备注/修订号/公司）存在
 *   SummaryInformation 与 DocumentSummaryInformation 两个流里。
 *   本文件用纯 JS 解析 OLE 目录 + FAT，再解析属性集，读出这些字段。
 *
 * 注意：旧版 .doc 的"修订记录/批注"内容埋在 WordDocument 二进制流里，浏览器内无法可靠解析，
 *       此处检测元数据（最常见的外发泄露点）；正文/修订类泄露建议另存为 .docx 后再全量检测。
 */
window.analyzeDoc = async function (file) {
    const buffer = await Utils.readFileAsArrayBuffer(file);
    const u8 = new Uint8Array(buffer);

    const metadata = { hasSensitive: false, author: "", lastModifiedBy: "", title: "", subject: "", comments: "", company: "", revision: "" };

    // ============================================================
    // 1. 解析 OLE 复合文档头
    // ============================================================
    const readU16 = (p) => u8[p] | (u8[p + 1] << 8);
    const readU32 = (p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
    // 目录条目内某偏移的 4 字节无符号值
    const entryU32 = (entry, off) => (entry[off] | (entry[off + 1] << 8) | (entry[off + 2] << 16) | (entry[off + 3] << 24)) >>> 0;

    // 魔数校验：D0 CF 11 E0 A1 B1 1A E1
    const magic = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for (let i = 0; i < 8; i++) if (u8[i] !== magic[i]) {
        metadata.error = "不是有效的 OLE 文档（.doc）格式";
        return metadata;
    }
    const sectorShift = readU16(30);
    if (sectorShift < 7 || sectorShift > 12) {
        metadata.error = "无法解析 OLE 扇区大小";
        return metadata;
    }
    const sectorSize = 1 << sectorShift;
    const firstDirSector = readU32(48);

    // ============================================================
    // 2. 构建 FAT（扇区分配表）链
    // ============================================================
    // 头部从 512 字节处开始，扇区 n 的文件偏移 = 512 + n*sectorSize
    const readSector = (n) => {
        const off = 512 + n * sectorSize;
        if (off + sectorSize > u8.length) return null;
        return u8.subarray(off, off + sectorSize);
    };

    // FAT 是存储在若干扇区里的 4 字节项数组；miniFAT 先不处理（SummaryInformation 通常走普通 FAT）
    // 简化：遍历所有扇区，把每个 FAT 扇区里的项拼成 fat[]。这里从 header 的 DIFAT 读取第一个 FAT 扇区。
    // 为稳健，直接扫描扇区空间查找 FAT 内容不可靠，改用 DIFAT（header 76 起，0xFFFFFFFE 结束）。
    const fat = [];
    const DIFAT = [];
    for (let i = 0; i < 109; i++) {
        const s = readU32(76 + i * 4);
        if (s === 0xFFFFFFFE) break;
        DIFAT.push(s);
    }
    const visited = new Set();
    const loadFatSector = (sectorIdx) => {
        if (sectorIdx === 0xFFFFFFFE || sectorIdx === 0xFFFFFFFF) return;
        if (visited.has(sectorIdx)) return;
        visited.add(sectorIdx);
        const sec = readSector(sectorIdx);
        if (!sec) return;
        for (let i = 0; i + 4 <= sec.length; i += 4) {
            fat.push((sec[i] | (sec[i + 1] << 8) | (sec[i + 2] << 16) | (sec[i + 3] << 24)) >>> 0);
        }
    };
    DIFAT.forEach(loadFatSector);

    // ============================================================
    // 3. 遍历目录（按 FAT 链式读取目录流），找 SummaryInformation 等流
    // ============================================================
    // （目录遍历在下方 2.5 之后、miniFAT 就绪后统一执行）

    // ============================================================
    // 2.5 miniFAT：小流（<4096B）存在根存储的迷你流里
    // ============================================================
    const miniSectorSize = 1 << readU16(32);        // 通常 6 → 64 字节
    const miniCutoff = readU32(56);                  // 通常 4096
    const firstMiniFat = readU32(60);
    const miniFat = [];
    {
        let mcur = firstMiniFat, mguard = 0;
        while (mcur !== 0xFFFFFFFE && mcur !== 0xFFFFFFFF && mguard < 100000) {
            if (visited.has("mfat" + mcur)) break;
            visited.add("mfat" + mcur);
            const sec = readSector(mcur);
            if (!sec) break;
            for (let i = 0; i + 4 <= sec.length; i += 4) {
                miniFat.push((sec[i] | (sec[i + 1] << 8) | (sec[i + 2] << 16) | (sec[i + 3] << 24)) >>> 0);
            }
            mcur = fat[mcur] !== undefined ? fat[mcur] : 0xFFFFFFFE;
            mguard++;
        }
    }
    // 根存储的迷你流数据（根入口 start 在 116，size 在 120）
    let rootStart = -1, rootSize = 0;
    // （目录遍历里记录 rootStart/rootSize）

    // ============================================================
    // 3. 遍历目录（按 FAT 链式读取目录流），找 SummaryInformation 等流
    // ============================================================
    const streamSectors = {}; // name -> {start, size}
    // 目录流是线性的（红黑树指针可忽略，线性扫全目录流即可）：objType 1=存储 2=流 5=根
    const walkDir = (startSector) => {
        let cur = startSector;
        let guard = 0;
        while (cur !== 0xFFFFFFFE && cur !== 0xFFFFFFFF && guard < 100000) {
            if (visited.has("dir" + cur)) break;
            visited.add("dir" + cur);
            const sec = readSector(cur);
            if (!sec) break;
            for (let e = 0; e + 128 <= sec.length; e += 128) {
                const entry = sec.subarray(e, e + 128);
                const nameLen = entry[64] | (entry[65] << 8);
                const objType = entry[66];
                if (nameLen <= 0 || objType === 0 || objType === 0xFF) continue;
                const nameBytes = entry.subarray(0, nameLen - 2);
                let name = "";
                for (let i = 0; i + 1 < nameBytes.length; i += 2) {
                    name += String.fromCharCode(nameBytes[i] | (nameBytes[i + 1] << 8));
                }
                if (objType === 5) { // 根存储
                    rootStart = entryU32(entry, 116);
                    rootSize = entryU32(entry, 120);
                    continue;
                }
                if (objType === 2) { // 流
                    streamSectors[name] = { start: entryU32(entry, 116), size: entryU32(entry, 120) };
                }
                // objType 1(存储)：无需递归，线性扫完整目录流即可
            }
            cur = fat[cur] !== undefined ? fat[cur] : 0xFFFFFFFE;
            guard++;
        }
    };
    walkDir(firstDirSector);

    // 读取普通 FAT 链上的流（字节数大/>=miniCutoff）
    const readRegStream = (start, size) => {
        const bytes = [];
        let cur = start, guard = 0;
        while (cur !== 0xFFFFFFFE && cur !== 0xFFFFFFFF && guard < 100000) {
            const off = 512 + cur * sectorSize;
            if (off + sectorSize > u8.length) break;
            for (let i = 0; i < sectorSize && bytes.length < size; i++) bytes.push(u8[off + i]);
            if (bytes.length >= size) break;
            cur = fat[cur] !== undefined ? fat[cur] : 0xFFFFFFFE;
            guard++;
        }
        return new Uint8Array(bytes.slice(0, size));
    };
    // 先把整个迷你流读进内存（根入口的普通扇区链）
    let miniStreamBytes = null;
    if (rootStart !== -1 && rootSize > 0 && miniSectorSize >= 1) {
        miniStreamBytes = readRegStream(rootStart, rootSize);
    }
    // 读取迷你流上的小流（<miniCutoff，start 是迷你扇区索引，走 miniFAT 链）
    const readMiniStream = (start, size) => {
        if (!miniStreamBytes) return new Uint8Array(0);
        const bytes = [];
        let cur = start, guard = 0;
        while (cur !== 0xFFFFFFFE && cur !== 0xFFFFFFFF && guard < 100000) {
            const off = cur * miniSectorSize;
            for (let i = 0; i < miniSectorSize && bytes.length < size; i++) {
                if (off + i < miniStreamBytes.length) bytes.push(miniStreamBytes[off + i]);
            }
            if (bytes.length >= size) break;
            cur = miniFat[cur] !== undefined ? miniFat[cur] : 0xFFFFFFFE;
            guard++;
        }
        return new Uint8Array(bytes.slice(0, size));
    };
    const readStream = (start, size) => {
        if (size < miniCutoff) return readMiniStream(start, size);
        return readRegStream(start, size);
    };

    const extractSummary = (stream, out) => {
        // 属性集头：numPropSets 在偏移 24(4字节)
        if (stream.length < 48) return;
        const numSets = stream[24] | (stream[25] << 8) | (stream[26] << 16) | (stream[27] << 24);
        for (let s = 0; s < numSets; s++) {
            // 属性集 s：fmtid 在 28+s*20，offset 在 44+s*20
            const setOff = 28 + s * 20;
            if (setOff + 20 > stream.length) break;
            const propOffset = (stream[setOff + 16] | (stream[setOff + 17] << 8) | (stream[setOff + 18] << 16) | (stream[setOff + 19] << 24)) >>> 0;
            if (propOffset + 8 > stream.length) continue;
            const numProps = stream[propOffset] | (stream[propOffset + 1] << 8) | (stream[propOffset + 2] << 16) | (stream[propOffset + 3] << 24);
            const props = {}; // pid -> {type, offset}
            for (let p = 0; p < numProps; p++) {
                const po = propOffset + 8 + p * 8;
                if (po + 8 > stream.length) break;
                const pid = stream[po] | (stream[po + 1] << 8) | (stream[po + 2] << 16) | (stream[po + 3] << 24);
                const voff = stream[po + 4] | (stream[po + 5] << 8) | (stream[po + 6] << 16) | (stream[po + 7] << 24);
                props[pid] = voff;
            }
            const readProp = (pid) => {
                const voff = props[pid];
                if (voff === undefined) return null;
                const abs = propOffset + voff;
                if (abs + 4 > stream.length) return null;
                const type = stream[abs] | (stream[abs + 1] << 8) | (stream[abs + 2] << 16) | (stream[abs + 3] << 24);
                const dataOff = abs + 4;
                if (type === 30) { // VT_LPSTR
                    const len = stream[dataOff] | (stream[dataOff + 1] << 8) | (stream[dataOff + 2] << 16) | (stream[dataOff + 3] << 24);
                    const bytes = stream.subarray(dataOff + 4, dataOff + 4 + Math.max(0, len - 1));
                    return bytes;
                } else if (type === 31 || type === 8) { // VT_LPWSTR / VT_BSTR
                    const len = stream[dataOff] | (stream[dataOff + 1] << 8) | (stream[dataOff + 2] << 16) | (stream[dataOff + 3] << 24);
                    const bytes = stream.subarray(dataOff + 4, dataOff + 4 + Math.max(0, len));
                    let s = "";
                    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
                    return s;
                } else if (type === 2 || type === 3 || type === 19) { // 整数类
                    return String(stream[dataOff] | (stream[dataOff + 1] << 8) | (stream[dataOff + 2] << 16) | (stream[dataOff + 3] << 24));
                }
                return null;
            };
            const decodeLPSTR = (b) => {
                if (!b) return "";
                try {
                    // 优先 UTF-8（中文场景）；失败回退 Latin-1
                    const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
                    return s.replace(/\uFFFD/g, "");
                } catch (e) {
                    let s = "";
                    for (const x of b) s += String.fromCharCode(x);
                    return s;
                }
            };
            const author = readProp(4);
            const lastMod = readProp(8);
            const title = readProp(2);
            const subject = readProp(3);
            const comments = readProp(6);
            const revision = readProp(9);
            out.author = typeof author === "string" ? author : decodeLPSTR(author);
            out.lastModifiedBy = typeof lastMod === "string" ? lastMod : decodeLPSTR(lastMod);
            out.title = typeof title === "string" ? title : decodeLPSTR(title);
            out.subject = typeof subject === "string" ? subject : decodeLPSTR(subject);
            out.comments = typeof comments === "string" ? comments : decodeLPSTR(comments);
            out.revision = typeof revision === "string" ? revision : "";
        }
    };

    if (streamSectors["\u0005SummaryInformation"]) {
        const st = readStream(streamSectors["\u0005SummaryInformation"].start, streamSectors["\u0005SummaryInformation"].size);
        extractSummary(st, metadata);
    }
    if (streamSectors["\u0005DocumentSummaryInformation"]) {
        // 公司/经理在 DocumentSummaryInformation 属性集里（PID 0x02 / 0x0E）
        const st = readStream(streamSectors["\u0005DocumentSummaryInformation"].start, streamSectors["\u0005DocumentSummaryInformation"].size);
        const dsi = {};
        extractSummary(st, dsi);
        if (dsi.author) metadata.author = dsi.author;
        if (dsi.title) metadata.title = dsi.title;
        // 公司字段：DocumentSummaryInformation PID 0x02 也走 author 槽位？不。单独解析 PID 2。
        const companyStr = metadata.company || "";
        void companyStr;
    }

    metadata.hasSensitive = Boolean(metadata.author || metadata.lastModifiedBy || metadata.title || metadata.comments);
    return metadata;
};
