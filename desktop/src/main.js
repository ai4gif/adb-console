// src/main.js — ADB Console 桌面 agent（macOS 未签名版）
// 托盘常驻 + 配置窗口：输入 relay 地址与 agent token，后台反向连接 relay 并执行本地 adb。
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { startAgent } = require('../lib/agent-lib');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

let tray = null;
let win = null;
let agent = null;

const STATUS_TEXT = { online: '● 已连接', connecting: '◌ 连接中', offline: '○ 未连接' };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return { relayUrl: 'http://127.0.0.1:4100', agentToken: 'dev-agent-token' }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

function adbPath() {
  const p = path.join(process.resourcesPath, 'adb', 'adb');
  if (fs.existsSync(p)) return p;                  // 打包后：Resources/adb/adb
  return process.env.ADB_BIN || 'adb';             // 开发/未打包：回退系统 adb
}

function startAgentWith(cfg) {
  if (agent) { try { agent.stop(); } catch (e) {} agent = null; }
  agent = startAgent({
    relayUrl: cfg.relayUrl, agentToken: cfg.agentToken, adbBin: adbPath(),
    onStatus: s => { if (win && !win.isDestroyed()) win.webContents.send('status', s); updateTray(s); }
  });
}
function stopAgent() {
  if (agent) { try { agent.stop(); } catch (e) {} agent = null; }
  if (win && !win.isDestroyed()) win.webContents.send('status', 'offline');
  updateTray('offline');
}
function updateTray(s) {
  if (tray) tray.setToolTip('ADB Console Agent — ' + (STATUS_TEXT[s] || s));
}

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 380, resizable: false, center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.on('close', e => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }  // 关窗口 = 最小化到托盘，agent 继续跑
  });
}

function createTray() {
  let icon = nativeImage.createFromPath(ICON);
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  tray = new Tray(icon);
  tray.setToolTip('ADB Console Agent — 未连接');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => win && win.show() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; stopAgent(); app.quit(); } }
  ]));
  tray.on('click', () => win && win.show());
}

app.whenReady().then(() => {
  createTray();
  createWindow();
  const cfg = loadConfig();
  win.webContents.on('did-finish-load', () => win.webContents.send('config', cfg));

  ipcMain.on('connect', (e, c) => { saveConfig(c); startAgentWith(c); });
  ipcMain.on('disconnect', () => stopAgent());

  startAgentWith(cfg);  // 启动即自动连上次配置
  app.on('activate', () => win && win.show());
});

app.on('window-all-closed', () => { /* 保留托盘与 agent，不退出 */ });
