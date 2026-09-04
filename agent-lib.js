// agent-lib.js — 边缘执行端核心逻辑（路线 A / 模式 Y），供 CLI（agent.js）与桌面端（Electron main）共用。
// 在「用户电脑」本地运行：反向 SSE 连接 relay，本地执行 adb 操控同网设备，回传结果。
// 零依赖（仅 Node 内置模块）。adb 二进制由 adbBin 指定（桌面端指向打包内的 resources/adb/adb）。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const core = require('./adb-core');

// startAgent 启动一个边缘 agent 实例。
// 返回 { stop(), isConnected() }，并通过 onStatus 回调上报连接状态（'connecting'|'online'|'offline'）。
function startAgent({ relayUrl, agentToken, adbBin, onStatus, artDir } = {}) {
  const RELAY = (relayUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const AGENT_TOKEN = agentToken || 'dev-agent-token';
  const ADB = adbBin || 'adb';
  const ART = artDir || path.join(os.tmpdir(), 'adb-agent-artifacts');
  fs.mkdirSync(ART, { recursive: true });

  const activeProcs = {};   // runId -> proc（供停止）
  let logProc = null, logBuffer = [], logRunId = null;
  let connected = false;
  let reconnectTimer = null;

  function report(state) {
    if (state === 'online') connected = true;
    else if (state === 'offline' || state === 'connecting') connected = false;
    if (onStatus) { try { onStatus(state); } catch (e) {} }
  }

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
  function execCommand(cmd) {
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
      result = core.runCommand('screencap', params, null, ART);
    } else if (type === 'log' && op === 'start') {
      startLog(runId);
      return; // 不 await，持续流式
    } else if (type === 'log' && op === 'stop') {
      result = stopLog();
    } else if (type === 'install' || type === 'uninstall' || type === 'custom' || type === 'log') {
      result = core.runCommandLive(type, params, filePath, runId, ART, onChunk, onActive);
    } else {
      result = { error: 'unsupported type: ' + type };
    }

    Promise.resolve(result).then(result => {
      if (result.error) { postResult({ runId, kind: 'done', feedback: { ok: false, text: result.error } }); return; }
      const output = result.output ? { ...result.output } : null;
      if (output && output.filePath) { try { output.b64 = fs.readFileSync(output.filePath).toString('base64'); } catch (e) {} delete output.filePath; }
      postResult({ runId, kind: 'done', feedback: result.feedback, output, type, params });
    });
  }

  function startLog(runId) {
    if (logProc) return;
    logRunId = runId; logBuffer = [];
    logProc = spawn(ADB, ['logcat']);
    logProc.stdout.on('data', d => {
      d.toString().split(/\r?\n/).filter(Boolean).forEach(l => { logBuffer.push(l); postResult({ runId, kind: 'logline', line: l }); });
    });
    logProc.stderr.on('data', () => {});
    logProc.on('exit', () => { if (logProc) { logProc = null; } });
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
        if (logRunId === obj.runId && logProc) { try { logProc.userStop = true; logProc.kill('SIGINT'); } catch (e) {} }
        return;
      }
      if (obj.action === 'command') execCommand(obj);
    }
  }

  // ---------- 轮询连接 relay（替代反向 SSE，兼容 Cloudflare 快速隧道） ----------
  let stopped = false;
  let _lastCmdId = 0, _pollTimer = null;
  function getJSON(targetUrl, cb) {
    const urlObj = new URL(targetUrl);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET', hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname + urlObj.search,
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    }, res => {
      if (res.statusCode !== 200) { res.resume(); cb(new Error('status ' + res.statusCode)); return; }
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(new Error('json')); } });
    });
    req.on('error', e => cb(e));
    req.end();
  }
  function pollRelay() {
    if (stopped) return;
    getJSON(RELAY + '/api/agent/poll?agentToken=' + encodeURIComponent(AGENT_TOKEN) + '&after=' + _lastCmdId, (err, data) => {
      if (err) { report('offline'); console.error('[agent] poll error:', err.message); return; }
      report('online');
      (data.commands || []).forEach(cmd => {
        _lastCmdId = Math.max(_lastCmdId, cmd.id || 0);
        handleCmd(cmd);
      });
    });
  }
  function pollLoop() {
    if (stopped) return;
    pollRelay();
    _pollTimer = setTimeout(pollLoop, 1500);
  }
  report('connecting');
  console.error('[agent] connecting relay (polling) ' + RELAY);
  pollLoop();
  console.error('[agent] ADB=' + ADB + '  ART=' + ART);

  return {
    stop() { stopped = true; if (_pollTimer) clearTimeout(_pollTimer); },
    isConnected() { return connected; }
  };
}

module.exports = { startAgent };
