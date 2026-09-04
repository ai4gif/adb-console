// ADB 控制台后端（零依赖版）：Node 内置 http + SSE，调用真实 adb 子进程
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

const ADB = process.env.ADB_BIN || 'adb';
const PORT = process.env.PORT || 3000;
const ART = path.join(__dirname, 'artifacts');
const LOGDIR = path.join(__dirname, 'logs');
fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
function appendLog(file, line) { try { fs.appendFileSync(path.join(LOGDIR, file), line + '\n'); } catch (e) {} }

// ---------- 状态 ----------
const state = { connected: false, ip: null, logRecording: false };
let logProc = null, logBuffer = [], logCounter = 0;
const results = [];
let idSeq = 1;
const sseClients = new Set();
let activeCmdProc = null; // 当前正在执行的 install/uninstall/custom 子进程（供 /api/command/stop 终止）
const DANGER = /(shell\s+rm\b|shell\s+reboot\b|shell\s+pm\s+clear\b|\brm\s+-rf\b|reboot\b|root\b|wipe\b|format\b|fastboot\b|mkfs\b|dd\s|shell\s+input\b)/i;

// ---------- 工具 ----------
function nowStr() { const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function validateIP(v) {
  if (!v) return { ok: false, msg: '请输入 IP 地址' };
  if (/[^0-9.:]/.test(v)) return { ok: false, msg: '非法字符' };
  if (v.length > 21) return { ok: false, msg: '非法长度' };
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/);
  if (!m) return { ok: false, msg: '格式应为 IP:端口，如 192.168.0.80:5555' };
  const oct = [m[1], m[2], m[3], m[4]].map(Number);
  if (oct.some(o => o > 255)) return { ok: false, msg: 'IP 每段需在 0–255' };
  const port = Number(m[5]);
  if (port < 1 || port > 65535) return { ok: false, msg: '端口需在 1–65535' };
  return { ok: true };
}
function runAdb(args, opts = {}) {
  return new Promise(resolve => {
    let proc, killed = false, timer = null;
    const timeout = opts.timeout || 0;
    try { proc = spawn(ADB, args); } catch (e) { return resolve({ code: 1, out: '', err: String(e) }); }
    if (timeout) timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch (e) {} }, timeout);
    let out = '', err = '';
    if (opts.binary) {
      const chunks = [];
      proc.stdout.on('data', d => chunks.push(d));
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks), err }); });
    } else {
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => err += d);
      proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
    }
    proc.on('error', e => { if (timer) clearTimeout(timer); resolve({ code: 1, out: '', err: String(e) }); });
    if (killed) resolve({ code: 1, out, err: err + '\n[adb 超时未响应，已终止]' });
  });
}
function broadcast(obj) {
  const s = 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
  sseClients.forEach(r => r.write(s));
}
function cmdNameOf(t) { return { log: '打log', install: '安装应用', uninstall: '删除应用', screencap: '截屏', custom: '自定义' }[t] || t; }
function writeArt(name, buf) { const fp = path.join(ART, name); fs.writeFileSync(fp, buf); return fp; }
function makeRec(type, send, feedback, output, params) {
  return { id: idSeq++, time: nowStr(), cmdName: cmdNameOf(type), send, feedback, output: output || null, type, params: params || null };
}
function toClient(rec) {
  const o = rec.output ? { ...rec.output } : null;
  if (o && o.filePath) o.url = '/api/files/' + rec.id;
  return { ...rec, output: o };
}
function addResult(rec, overwriteId) {
  if (overwriteId) { const i = results.findIndex(r => r.id === overwriteId); if (i >= 0) { results[i] = rec; return; } }
  results.unshift(rec);
}
function readJson(req) {
  return new Promise(res => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } }); });
}
function readRaw(req) {
  return new Promise(res => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
}

// ---------- 日志采集 ----------
function startLog() {
  if (logProc) return;
  logBuffer = []; state.logRecording = true;
  logProc = spawn(ADB, ['logcat']);
  logProc.stdout.on('data', d => {
    d.toString().split(/\r?\n/).filter(Boolean).forEach(l => { logBuffer.push(l); broadcast({ type: 'log', line: l }); });
  });
  logProc.stderr.on('data', () => {});
  broadcast({ type: 'status', ...state, ip: state.ip });
}
function stopLogAndSave() {
  return new Promise(resolve => {
    state.logRecording = false; // 先落状态，避免竞态导致重复停止
    if (!logProc) { broadcast({ type: 'status', ...state, ip: state.ip }); return resolve({ feedback: { ok: true, text: 'SUCCESS' }, output: null }); }
    const p = logProc; logProc = null;
    p.kill('SIGINT');
    setTimeout(() => {
      const name = 'log' + (++logCounter) + '.txt';
      const fp = writeArt(name, logBuffer.join('\n') + '\n');
      broadcast({ type: 'status', ...state, ip: state.ip });
      resolve({ feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name, filePath: fp } });
    }, 400);
  });
}

// ---------- 指令执行 ----------
async function runCommand(type, params = {}, filePath = null) {
  if (type === 'install') {
    if (!filePath) return { error: '缺少 apk 文件' };
    const r = await runAdb(['install', '-r', filePath]);
    const detail = (r.out + '\n' + r.err).trim();
    const ok = r.code === 0 && !/Failure/i.test(detail);
    let output = null;
    if (!ok) { const fp = writeArt('error_' + Date.now() + '.txt', detail || 'install failed'); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return { feedback: ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }, output };
  }
  if (type === 'uninstall') {
    const pkg = params.pkg; if (!pkg) return { error: '缺少包名' };
    const r = await runAdb(['uninstall', pkg]);
    const detail = (r.out + '\n' + r.err).trim();
    const ok = r.code === 0 && !/Failure/i.test(detail);
    let output = null;
    if (!ok) { const fp = writeArt('error_' + Date.now() + '.txt', detail || 'uninstall failed'); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return { feedback: ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }, output };
  }
  if (type === 'screencap') {
    // 网络 adb 上 exec-out 流式截屏易 "error: closed"，改用「设备存文件 + pull + 清理」更稳
    const fp = path.join(ART, 'shot_' + Date.now() + '.png');
    const devPath = '/sdcard/__adb_console_shot.png';
    const r1 = await runAdb(['shell', 'screencap', '-p', devPath], { timeout: 15000 });
    if (r1.code !== 0) return { feedback: { ok: false, text: 'FAILURE: ' + (r1.err || r1.out || 'screencap failed').trim().slice(0, 120) }, output: null };
    await runAdb(['pull', devPath, fp], { timeout: 15000 });
    await runAdb(['shell', 'rm', devPath]); // 清理设备端临时文件，忽略失败
    if (!fs.existsSync(fp) || fs.statSync(fp).size === 0) return { feedback: { ok: false, text: 'FAILURE: 截图拉取失败（设备可能无存储权限）' }, output: null };
    return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'image', name: path.basename(fp), filePath: fp } };
  }
  if (type === 'custom') {
    const cmd = (params.cmd || '').trim(); if (!cmd) return { error: '命令为空' };
    if (DANGER.test(cmd)) return { error: '该命令被安全策略禁止执行（危险命令）' };
    // 自动补全 shell 前缀：首词不是已知 adb 动词时，默认按 shell 执行（如 getprop/pm/am/dumpsys…）
    const ADB_VERBS = /^(shell|exec-out|exec|install|uninstall|push|pull|forward|reverse|reboot|connect|disconnect|devices|wait-for-device|start-server|kill-server|tcpip|usb|logcat|bugreport|backup|restore|keygen|version|help|get-state|get-serialno|get-devpath|status-window|jdwp|track-devices|emu)\b/;
    const full = ADB_VERBS.test(cmd) ? cmd : ('shell ' + cmd);
    const r = await runAdb(full.split(/\s+/), { timeout: 15000 });
    const content = '$ adb ' + full + '\n' + (r.out || '') + (r.err || '') + 'exit-code: ' + r.code + '\n';
    const fp = writeArt('cmd_out_' + Date.now() + '.txt', content);
    return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name: 'cmd_out.txt', filePath: fp } };
  }
  return { error: '未知指令类型' };
}

// 流式执行：边跑边通过 SSE 推送 stdout，支持中途停止（install / uninstall / custom）
async function runCommandLive(type, params = {}, filePath = null, runId = '') {
  let args, full = null;
  if (type === 'install') {
    if (!filePath) return { error: '缺少 apk 文件' };
    args = ['install', '-r', filePath];
  } else if (type === 'uninstall') {
    const pkg = params.pkg; if (!pkg) return { error: '缺少包名' };
    args = ['uninstall', pkg];
  } else if (type === 'custom') {
    const cmd = (params.cmd || '').trim(); if (!cmd) return { error: '命令为空' };
    if (DANGER.test(cmd)) return { error: '该命令被安全策略禁止执行（危险命令）' };
    const ADB_VERBS = /^(shell|exec-out|exec|install|uninstall|push|pull|forward|reverse|reboot|connect|disconnect|devices|wait-for-device|start-server|kill-server|tcpip|usb|logcat|bugreport|backup|restore|keygen|version|help|get-state|get-serialno|get-devpath|status-window|jdwp|track-devices|emu)\b/;
    full = ADB_VERBS.test(cmd) ? cmd : ('shell ' + cmd);
    args = full.split(/\s+/);
  } else {
    return { error: '不支持的实时指令' };
  }

  const proc = spawn(ADB, args);
  activeCmdProc = proc; proc.userStop = false;
  // 先推一行「正在执行的命令」，让前端回显窗口显示上下文
  const disp = (type === 'custom' ? ('$ adb ' + full) : ('$ adb ' + args.join(' ')));
  if (runId) broadcast({ type: 'cmd', runId, chunk: disp + '\n' });
  let out = '', err = '';
  proc.stdout.on('data', d => { const s = d.toString(); out += s; if (runId) broadcast({ type: 'cmd', runId, chunk: s }); });
  proc.stderr.on('data', d => { const s = d.toString(); err += s; if (runId) broadcast({ type: 'cmd', runId, chunk: s }); });
  const code = await new Promise(res => proc.on('close', c => res(c === null ? 1 : c)));
  activeCmdProc = null;
  const detail = (out + '\n' + err).trim();

  if (type === 'install' || type === 'uninstall') {
    const ok = proc.userStop ? false : (code === 0 && !/Failure/i.test(detail));
    let output = null;
    if (!ok && detail) { const fp = writeArt('error_' + Date.now() + '.txt', detail); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return {
      feedback: proc.userStop ? { ok: false, text: '已停止 (用户终止)' }
        : (ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }),
      output
    };
  }
  // custom：落盘完整输出
  if (proc.userStop) return { feedback: { ok: false, text: '已停止 (用户终止)' }, output: null };
  const label = full ? ('$ adb ' + full) : '$ adb';
  const content = label + '\n' + out + (err || '') + 'exit-code: ' + code + '\n';
  const fp = writeArt('cmd_out_' + Date.now() + '.txt', content);
  return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name: 'cmd_out.txt', filePath: fp } };
}

// ---------- HTTP 处理 ----------
function json(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function sendFile(res, fp, ct) {
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': ct }); res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const _t0 = Date.now();
  res.on('finish', () => { appendLog('access.log', JSON.stringify({ t: new Date().toISOString(), m: req.method, p: u.pathname, status: res.statusCode, ms: Date.now() - _t0 })); });
  const p = u.pathname;
  const m = req.method;

  // 允许跨源（预览面板以不同源/端口打开本页时，前端仍可访问后端）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Run-Id');
  if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 可选访问令牌：设置环境变量 ADB_CONSOLE_TOKEN 后，所有 API（含 SSE）需携带令牌；未设置则完全开放（本地使用）
  const TOKEN = process.env.ADB_CONSOLE_TOKEN || '';
  const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (u.query.token || '');
  const NEED_AUTH = TOKEN && p !== '/' && p !== '/favicon.ico';
  if (NEED_AUTH && provided !== TOKEN) {
    if (p === '/api/stream') { res.writeHead(401); return res.end(); }
    return json(res, { ok: false, error: 'unauthorized' }, 401);
  }

  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 2000\n\n');
    res.write('event: status\ndata: ' + JSON.stringify({ type: 'status', ...state, ip: state.connected ? state.ip : null }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (p === '/' && m === 'GET') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); } // 避免无 favicon 的 404 噪音

  if (m === 'GET' && p === '/api/status') return json(res, { ...state, ip: state.connected ? state.ip : null });

  if (m === 'GET' && p === '/api/devices') {
    const r = await runAdb(['devices', '-l'], { timeout: 8000 });
    const lines = (r.out || '').split(/\r?\n/).filter(Boolean);
    const devs = [];
    for (const ln of lines.slice(1)) {
      const mm = ln.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (mm) devs.push({ id: mm[1], state: mm[2], extra: mm[3] || '' });
    }
    return json(res, { devices: devs });
  }

  if (m === 'POST' && p === '/api/event') {
    const b = await readJson(req);
    if (b && b.action) appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: b.action, detail: b.detail || null, ua: b.ua || null }));
    return json(res, { ok: true });
  }
  if (m === 'GET' && p === '/api/events') {
    const n = Math.min(1000, parseInt(u.query.n || '300'));
    let lines = [];
    try { lines = fs.readFileSync(path.join(LOGDIR, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch (e) {}
    const rows = lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    return json(res, { rows, total: lines.length });
  }

  if (m === 'POST' && p === '/api/connect') {
    const body = await readJson(req);
    const v = validateIP(body.ip);
    if (!v.ok) return json(res, { ok: false, reason: v.msg });
    const r = await runAdb(['connect', body.ip], { timeout: 10000 });
    const success = /connected to/i.test(r.out);
    state.connected = success; state.ip = success ? body.ip : null;
    let reason = success ? '' : (r.out || r.err || '连接失败').trim().slice(0, 160);
    let hint = '';
    if (!success && reason) {
      const low = reason.toLowerCase();
      if (/connection refused|failed to connect/i.test(reason)) hint = '目标无响应：确认 IP:端口 正确、设备已执行 adb tcpip 5555、与 Mac 同一网段、且防火墙未拦截 5555。';
      else if (/device offline/i.test(low)) hint = '设备离线：在设备上重新执行 adb tcpip 5555 后重试。';
      else if (/unauthorized|device unauthorized/i.test(low)) hint = '设备未授权：在设备屏幕点击「允许 USB 调试」。';
      else if (/host doesn't|cannot connect|timed out|timeout/i.test(low)) hint = '网络不可达：确认设备与 Mac 处于同一 Wi-Fi，且 5555 端口已开启。';
    }
    broadcast({ type: 'status', ...state, ip: state.ip });
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'server:connect', detail: { ip: body.ip, ok: success, reason } }));
    return json(res, { ok: success, reason, hint });
  }

  if (m === 'POST' && p === '/api/disconnect') {
    if (state.logRecording) stopLogAndSave();
    if (state.connected && state.ip) await runAdb(['disconnect', state.ip]);
    state.connected = false; state.ip = null;
    broadcast({ type: 'status', ...state, ip: null });
    return json(res, { ok: true });
  }

  if (m === 'POST' && p === '/api/command/stop') {
    if (activeCmdProc && !activeCmdProc.killed) {
      try { activeCmdProc.userStop = true; activeCmdProc.kill('SIGKILL'); } catch (e) {}
      return json(res, { ok: true, stopped: true });
    }
    return json(res, { ok: true, stopped: false });
  }

  if (m === 'POST' && p === '/api/command') {
    if (!state.connected) return json(res, { ok: false, reason: '设备未连接' });
    const ct = req.headers['content-type'] || '';
    let type, params = {}, filePath = null;
    if (ct.includes('application/octet-stream')) {
      type = 'install';
      const buf = await readRaw(req);
      if (!buf.length) return json(res, { ok: false, reason: '请上传 apk 文件' });
      filePath = writeArt('install_' + Date.now() + '.apk', buf);
    } else {
      const body = await readJson(req);
      type = body.type; params = body.params || {};
    }
    if (type === 'log') {
      if (!state.logRecording) { startLog(); return json(res, { ok: true, recording: true }); }
      const saved = await stopLogAndSave();
      const rec = makeRec('log', '已下发', saved.feedback, saved.output);
      addResult(rec);
      appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'server:command', detail: { type: 'log', ok: saved.feedback.ok, text: saved.feedback.text, params: { stop: true } } }));
      return json(res, { ok: true, record: toClient(rec) });
    }
    if (type === 'install' && !filePath) return json(res, { ok: false, reason: '请上传 apk 文件' });
    if (type === 'uninstall') params.pkg = params.pkg || '';
    const runId = req.headers['x-run-id'] || '';
    let r;
    if (type === 'install' || type === 'uninstall' || type === 'custom') {
      r = await runCommandLive(type, params, filePath, runId); // 流式：边跑边推 SSE cmd 事件
    } else {
      r = await runCommand(type, params, filePath);
    }
    if (r.error) return json(res, { ok: false, reason: r.error });
    const rec = makeRec(type, '已下发', r.feedback, r.output, params);
    addResult(rec);
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'server:command', detail: { type, ok: r.feedback.ok, text: r.feedback.text, params } }));
    return json(res, { ok: true, record: toClient(rec) });
  }

  const retryMatch = p.match(/^\/api\/command\/(\d+)\/retry$/);
  if (m === 'POST' && retryMatch) {
    if (!state.connected) return json(res, { ok: false, reason: '设备未连接' });
    const rec = results.find(r => r.id == retryMatch[1]);
    if (!rec) return json(res, { ok: false, reason: '记录不存在' });
    if (rec.type === 'log') {
      startLog();
      const saved = await new Promise(r => setTimeout(async () => r(await stopLogAndSave()), 900));
      const nr = makeRec('log', '已下发', saved.feedback, saved.output);
      addResult(nr, rec.id);
      return json(res, { ok: true, record: toClient(nr) });
    }
    const filePath = rec.output && rec.output.filePath ? rec.output.filePath : null;
    const r = await runCommand(rec.type, rec.params || {}, filePath);
    if (r.error) return json(res, { ok: false, reason: r.error });
    const nr = makeRec(rec.type, '已下发', r.feedback, r.output, rec.params);
    addResult(nr, rec.id);
    return json(res, { ok: true, record: toClient(nr) });
  }

  if (m === 'GET' && p === '/api/results') {
    const page = Math.max(1, parseInt(u.query.page || '1'));
    const size = Math.min(50, parseInt(u.query.size || '10'));
    const total = results.length, pages = Math.max(1, Math.ceil(total / size));
    const start = (page - 1) * size;
    return json(res, { rows: results.slice(start, start + size).map(toClient), total, page, pages });
  }

  const delMatch = p.match(/^\/api\/results\/(\d+)$/);
  if (m === 'DELETE' && delMatch) {
    const id = Number(delMatch[1]);
    const i = results.findIndex(r => r.id === id);
    if (i < 0) return json(res, { ok: false, reason: '记录不存在' }, 404);
    const rec = results[i];
    const fp = rec.output && rec.output.filePath;
    if (fp && fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
    results.splice(i, 1);
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'server:delete', detail: { id } }));
    return json(res, { ok: true });
  }

  const fileMatch = p.match(/^\/api\/files\/(\d+)$/);
  if (m === 'GET' && fileMatch) {
    const rec = results.find(r => r.id == fileMatch[1]);
    if (!rec || !rec.output || !rec.output.filePath) { res.writeHead(404); return res.end('not found'); }
    const fp = rec.output.filePath;
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('file missing'); }
    const dl = u.query.download === '1';
    res.setHeader('Content-Disposition', (dl ? 'attachment' : 'inline') + '; filename="' + encodeURIComponent(rec.output.name) + '"');
    if (rec.output.kind === 'image') res.setHeader('Content-Type', 'image/png');
    else if (rec.output.kind === 'apk') res.setHeader('Content-Type', 'application/octet-stream');
    else res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return sendFile(res, fp, res.getHeader('Content-Type'));
  }

  json(res, { error: 'not found' }, 404);
});

server.listen(PORT, '127.0.0.1', () => console.error('[adb-console] listening on http://127.0.0.1:' + PORT));
