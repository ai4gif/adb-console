// src/preload.js — 安全桥：向渲染进程暴露最小 API（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onConfig: cb => ipcRenderer.on('config', (e, v) => cb(v)),
  onStatus: cb => ipcRenderer.on('status', (e, v) => cb(v)),
  connect: cfg => ipcRenderer.send('connect', cfg),
  disconnect: () => ipcRenderer.send('disconnect')
});
