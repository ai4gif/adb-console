// agent.js — 边缘执行端（路线 A / 模式 Y）
// 在「用户电脑」本地运行：反向 WSS/SSE 连接 relay，本地执行 adb 操控同网设备，回传结果。
// 零依赖：仅 Node 内置模块。adb 二进制来自 PATH 或 ADB_BIN 环境变量。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const core = require('./adb-core');

const RELAY = (process.env.RELAY_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';
const ADB = process.env.ADB_BIN || 'adb';
const ART = path.join(os.tmpdir(), 'adb-agent-artifacts');
fs.mkdirSync(ART, { recursive: true });

// ---------- 状态 ----------
const activeProcs = {};   // runId -> proc（供停止）
let logProc = null, logBuffer = [], logRunId = null;

// ---------- 回传 helper ----------
function postResult(body) {
  const data = JSON.stringify(body);
  const u = new URL(RELAY + '/api/agent/result');
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({
    method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_TOKEN, 'Content-Length': Buffer.byteLength(data) }
  }, r => { r.resume(); });
  req.on('error', e => console.error('[agent] postResult error:', e.message));
  req.write(data); req.end();
}

// ---------- adb 执行 ----------
async function execCommand(cmd) {
  const { runId, type, params = {}, fileB64, op } = cmd;
  let filePath = null;
  if (type === 'install' && fileB64) {
    filePath = path.join(ART, 'inst_' + Date.now() + '.apk');
    fs.writeFileSync(filePath, Buffer.from(fileB64, 'base64'));
  }
  const onChunk = chunk => postResult({ runId, kind: 'chunk', chunk });
  const onActive = proc => { activeProcs[runId] = proc; };

  let result;
  if (type === 'screencap') {
    result = await core.runCommand('screencap', params, null, ART);
  } else if (type === 'log' && op === 'start') {
    startLog(runId);
    return; // 不 await，持续流式
  } else if (type === 'log' && op === 'stop') {
    result = await stopLog();
  } else if (type === 'install' || type === 'uninstall' || type === 'custom' || type === 'log') {
    result = await core.runCommandLive(type, params, filePath, runId, ART, onChunk, onActive);
  } else {
    result = { error: 'unsupported type: ' + type };
  }

  if (result.error) { postResult({ runId, kind: 'done', feedback: { ok: false, text: result.error } }); return; }
  const output = result.output ? { ...result.output } : null;
  if (output && output.filePath) { try { output.b64 = fs.readFileSync(output.filePath).toString('base64'); } catch (e) {} delete output.filePath; }
  postResult({ runId, kind: 'done', feedback: result.feedback, output, type, params });
}

function startLog(runId) {
  if (logProc) return;
  logRunId = runId; logBuffer = [];
  logProc = spawn(ADB, ['logcat']);
  logProc.stdout.on('data', d => {
    d.toString().split(/\r?\n/).filter(Boolean).forEach(l => { logBuffer.push(l); postResult({ runId, kind: 'logline', line: l }); });
  });
  logProc.stderr.on('data', () => {});
}
function stopLog() {
  return new Promise(resolve => {
    if (!logProc) return resolve({ feedback: { ok: true, text: 'SUCCESS' }, output: null });
    const p = logProc; logProc = null;
    p.kill('SIGINT');
    setTimeout(() => {
      const name = 'log_' + Date.now() + '.txt';
      const fp = path.join(ART, name);
      fs.writeFileSync(fp, logBuffer.join('\n') + '\n');
      resolve({ feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name, filePath: fp } });
    }, 400);
  });
}

// ---------- 指令分发 ----------
function handleCmd(obj) {
  if (obj.reqId) {
    if (obj.action === 'connect') {
      core.connectDevice(obj.ip).then(r => postResult({ reqId: obj.reqId, connected: r.ok, ip: obj.ip, reason: r.reason, hint: r.hint }));
    } else if (obj.action === 'devices') {
      core.listDevices().then(devs => postResult({ reqId: obj.reqId, devices: devs }));
    } else if (obj.action === 'disconnect') {
      core.runAdb(['disconnect', obj.ip || '']).then(() => {});
    }
    return;
  }
  if (obj.runId) {
    if (obj.action === 'stop') {
      const proc = activeProcs[obj.runId] || (logRunId === obj.runId ? logProc : null);
      if (proc) { try { proc.userStop = true; proc.kill('SIGKILL'); } catch (e) {} }
      // log 停止由 stopLog 走 done
      if (logRunId === obj.runId && logProc) { try { logProc.userStop = true; logProc.kill('SIGINT'); } catch (e) {} }
      return;
    }
    if (obj.action === 'command') execCommand(obj);
  }
}

// ---------- 反向 SSE 连接 relay ----------
let buf = '';
function connectRelay() {
  const u = new URL(RELAY + '/api/agent/stream?agentToken=' + encodeURIComponent(AGENT_TOKEN));
  const lib = u.protocol === 'https:' ? https : http;
  console.error('[agent] connecting relay ' + RELAY);
  const req = lib.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' } }, res => {
    if (res.statusCode !== 200) { console.error('[agent] relay refused:', res.statusCode); res.resume(); setTimeout(connectRelay, 3000); return; }
    console.error('[agent] connected to relay');
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = 'message', data = '';
        block.split('\n').forEach(line => {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        });
        if (ev === 'cmd' && data) { try { handleCmd(JSON.parse(data)); } catch (e) { console.error('[agent] parse err', e.message); } }
      }
    });
    res.on('end', () => { console.error('[agent] relay stream ended, reconnect in 3s'); setTimeout(connectRelay, 3000); });
  });
  req.on('error', e => { console.error('[agent] relay error:', e.message, '-> reconnect in 3s'); setTimeout(connectRelay, 3000); });
  req.end();
}

connectRelay();
console.error('[agent] ADB=' + ADB + '  ART=' + ART);
