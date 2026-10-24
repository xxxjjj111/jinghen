/**
 * preload.js — 在渲染进程里安全暴露少量原生能力给页面。
 *
 * 只暴露一个 saveFile（保存清洗结果），通过 contextBridge 隔离，
 * 页面拿不到 Node 权限，只能调用这一个受限接口。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // data: 文件字节（ArrayBuffer），filename: 建议的文件名
    saveFile: (data, filename) => ipcRenderer.invoke("save-file", data, filename),
});
