// src/renderer.js — 配置窗口逻辑
const relay = document.getElementById('relay');
const token = document.getElementById('token');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const hdot = document.getElementById('hdot');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');

function applyStatus(s) {
  statusBox.className = 'status' + (s && s !== 'offline' ? ' ' + s : '');
  const t = { online: '● 已连接', connecting: '◌ 连接中', offline: '○ 未连接' }[s] || '未连接';
  statusText.textContent = t;
  hdot.style.background = s === 'online' ? 'var(--green)' : s === 'connecting' ? 'var(--teal)' : 'var(--muted)';
}

btnConnect.addEventListener('click', () => {
  const cfg = { relayUrl: relay.value.trim() || 'http://127.0.0.1:4100', agentToken: token.value.trim() || 'dev-agent-token' };
  window.api.connect(cfg);
});
btnDisconnect.addEventListener('click', () => window.api.disconnect());

window.api.onConfig(c => { relay.value = c.relayUrl || ''; token.value = c.agentToken || ''; });
window.api.onStatus(s => applyStatus(s));
applyStatus('offline');
