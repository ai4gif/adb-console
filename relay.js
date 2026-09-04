// relay.js — 云端中继（路线 A / 模式 Y）
// 托管 UI + 浏览器 SSE + 浏览器 API；把指令转发给已连接的本地 agent（反向 SSE），
// 再把 agent 回传的结果经 SSE 推回浏览器。relay 自身不执行 adb。
// 零依赖：仅用 Node 内置模块（http / fs / path / url / child_process）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ART = path.join(__dirname, 'artifacts');
const LOGDIR = path.join(__dirname, 'logs');
fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
function appendLog(file, line) { try { fs.appendFileSync(path.join(LOGDIR, file), line + '\n'); } catch (e) {} }

// ---------- 鉴权 ----------
const TOKEN = process.env.ADB_CONSOLE_TOKEN || '';          // 浏览器访问令牌（可选）
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token'; // agent<->relay 凭证

// ---------- 状态 ----------
const state = { connected: false, ip: null, logRecording: false, agentOnline: false };
const results = [];
let idSeq = 1, runSeq = 1, reqSeq = 1, logRunId = null, activeRunId = null;
const sseClients = new Set();   // 浏览器 SSE
let agentRes = null;            // agent 的 SSE 响应（relay→agent 指令通道）
const pendingReqs = new Map();  // reqId -> {resolve, timer}  (connect/devices 请求-响应)
const pendingDone = new Map();  // runId -> {resolve, timer}  (command 流式完成)

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
function sseEvent(type, data) { return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
function broadcast(obj) {
  const s = sseEvent(obj.type, obj);
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

// agent 回传的 done 构造为最终 record（文件 b64 落盘到 relay）
function finalizeRecord(body) {
  let output = null;
  if (body.output) {
    const o = { kind: body.output.kind, name: body.output.name };
    if (body.output.b64) {
      const ext = o.kind === 'image' ? '.png' : (o.kind === 'apk' ? '.apk' : '.txt');
      const fp = writeArt('agent_' + Date.now() + ext, Buffer.from(body.output.b64, 'base64'));
      o.filePath = fp;
    } else if (body.output.filePath) {
      o.filePath = body.output.filePath;
    }
    output = o;
  }
  return makeRec(body.type || 'custom', '已下发', body.feedback || { ok: true, text: 'SUCCESS' }, output, body.params || null);
}

// 把指令推给 agent（relay→agent SSE）
function pushAgent(obj) { if (agentRes) { try { agentRes.write(sseEvent('cmd', obj)); return true; } catch (e) { agentRes = null; } } return false; }

// ---------- HTTP ----------
function json(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function sendFile(res, fp, ct) {
  fs.readFile(fp, (e, buf) => { if (e) { res.writeHead(404); res.end('not found'); return; } res.writeHead(200, { 'Content-Type': ct }); res.end(buf); });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const _t0 = Date.now();
  res.on('finish', () => { appendLog('access.log', JSON.stringify({ t: new Date().toISOString(), m: req.method, p: u.pathname, status: res.statusCode, ms: Date.now() - _t0 })); });
  const p = u.pathname;
  const m = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Run-Id');
  if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 浏览器访问令牌
  const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (u.query.token || '');
  const NEED_AUTH = TOKEN && p !== '/' && p !== '/favicon.ico';
  if (NEED_AUTH && provided !== TOKEN) {
    if (p === '/api/stream') { res.writeHead(401); return res.end(); }
    return json(res, { ok: false, error: 'unauthorized' }, 401);
  }

  // ===== agent 接入（反向 SSE）=====
  if (p === '/api/agent/stream' && m === 'GET') {
    const at = u.query.agentToken || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (at !== AGENT_TOKEN) { res.writeHead(401); return res.end('unauthorized agent'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n');
    // 若已有 agent 连接，替换
    if (agentRes) { try { agentRes.end(); } catch (e) {} }
    agentRes = res;
    state.agentOnline = true;
    broadcast({ type: 'status', ...state, ip: state.connected ? state.ip : null });
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ka); if (agentRes === res) { agentRes = null; state.agentOnline = false; broadcast({ type: 'status', ...state, ip: state.connected ? state.ip : null }); } });
    return;
  }

  // ===== agent 回传结果 =====
  if (m === 'POST' && p === '/api/agent/result') {
    const at = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (u.query.token || '');
    if (at !== AGENT_TOKEN) return json(res, { ok: false, error: 'unauthorized agent' }, 401);
    const b = await readJson(req);
    if (b.reqId && pendingReqs.has(b.reqId)) {
      const pr = pendingReqs.get(b.reqId); pendingReqs.delete(b.reqId); clearTimeout(pr.timer); pr.resolve(b);
      return json(res, { ok: true });
    }
    if (b.runId) {
      if (b.kind === 'chunk') broadcast({ type: 'cmd', runId: b.runId, chunk: b.chunk });
      else if (b.kind === 'logline') broadcast({ type: 'log', line: b.line });
      else if (b.kind === 'done') {
        const rec = finalizeRecord(b);
        addResult(rec);
        broadcast({ type: 'done', record: toClient(rec) });
        if (pendingDone.has(b.runId)) { const d = pendingDone.get(b.runId); pendingDone.delete(b.runId); clearTimeout(d.timer); d.resolve(rec); }
      }
      return json(res, { ok: true });
    }
    return json(res, { ok: false });
  }

  // ===== 浏览器 SSE =====
  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 2000\n\n');
    res.write(sseEvent('status', { ...state, ip: state.connected ? state.ip : null }));
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (p === '/' && m === 'GET') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (m === 'GET' && p === '/api/status') return json(res, { ...state, ip: state.connected ? state.ip : null });

  if (m === 'GET' && p === '/api/devices') {
    if (!agentRes) return json(res, { devices: [], agentOffline: true });
    const reqId = 'r' + (++reqSeq);
    const pr = new Promise(r => { const t = setTimeout(() => { pendingReqs.delete(reqId); r({ devices: [] }); }, 12000); pendingReqs.set(reqId, { resolve: r, timer: t }); });
    pushAgent({ reqId, action: 'devices' });
    const r = await pr;
    return json(res, { devices: r.devices || [] });
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
    if (!agentRes) return json(res, { ok: false, reason: 'agent 离线，无法连接设备' });
    const reqId = 'r' + (++reqSeq);
    const pr = new Promise(r => { const t = setTimeout(() => { pendingReqs.delete(reqId); r({ connected: false, reason: 'agent 无响应（超时）' }); }, 15000); pendingReqs.set(reqId, { resolve: r, timer: t }); });
    pushAgent({ reqId, action: 'connect', ip: body.ip });
    const r = await pr;
    state.connected = r.connected; state.ip = r.connected ? body.ip : null;
    broadcast({ type: 'status', ...state, ip: state.ip });
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'relay:connect', detail: { ip: body.ip, ok: r.connected, reason: r.reason } }));
    return json(res, { ok: r.connected, reason: r.reason, hint: r.hint });
  }

  if (m === 'POST' && p === '/api/disconnect') {
    if (state.logRecording) { pushAgent({ runId: logRunId, action: 'command', type: 'log', op: 'stop' }); }
    if (state.connected && state.ip && agentRes) pushAgent({ action: 'disconnect', ip: state.ip });
    state.connected = false; state.ip = null; state.logRecording = false;
    broadcast({ type: 'status', ...state, ip: null });
    return json(res, { ok: true });
  }

  if (m === 'POST' && p === '/api/command/stop') {
    if (!logRunId && !activeRunId) return json(res, { ok: true, stopped: false });
    const rid = activeRunId || logRunId;
    pushAgent({ runId: rid, action: 'stop' });
    return json(res, { ok: true, stopped: true });
  }

  if (m === 'POST' && p === '/api/command') {
    if (!state.connected) return json(res, { ok: false, reason: '设备未连接' });
    if (!agentRes) return json(res, { ok: false, reason: 'agent 离线，无法执行' });
    const ct = req.headers['content-type'] || '';
    let type, params = {}, fileB64 = null, filePath = null;
    if (ct.includes('application/octet-stream')) {
      type = 'install';
      const buf = await readRaw(req);
      if (!buf.length) return json(res, { ok: false, reason: '请上传 apk 文件' });
      fileB64 = buf.toString('base64');
    } else {
      const body = await readJson(req);
      type = body.type; params = body.params || {};
    }

    // 危险指令在 relay 端也拦截（防御纵深；前端已拦但直连 API 可绕过）
    if ((type === 'custom' || type === 'shell') && DANGER.test((params.cmd || ''))) return json(res, { ok: false, reason: '该命令被安全策略禁止执行（危险命令）' });

    if (type === 'log') {
      if (!state.logRecording) {
        const runId = 'run' + (++runSeq); logRunId = runId; activeRunId = runId; state.logRecording = true;
        pushAgent({ runId, action: 'command', type: 'log', op: 'start' });
        broadcast({ type: 'status', ...state, ip: state.ip });
        return json(res, { ok: true, recording: true });
      } else {
        const runId = logRunId;
        const pr = new Promise(r => { const t = setTimeout(() => { pendingDone.delete(runId); r(null); }, 30000); pendingDone.set(runId, { resolve: r, timer: t }); });
        pushAgent({ runId, action: 'command', type: 'log', op: 'stop' });
        const rec = await pr; state.logRecording = false; activeRunId = null;
        broadcast({ type: 'status', ...state, ip: state.ip });
        if (!rec) return json(res, { ok: false, reason: 'log 停止超时' });
        return json(res, { ok: true, record: toClient(rec) });
      }
    }

    if (type === 'install' && !fileB64) return json(res, { ok: false, reason: '请上传 apk 文件' });
    if (type === 'uninstall') params.pkg = params.pkg || '';

    const runId = 'run' + (++runSeq); activeRunId = runId;
    const pr = new Promise(r => { const t = setTimeout(() => { pendingDone.delete(runId); r(null); }, 120000); pendingDone.set(runId, { resolve: r, timer: t }); });
    pushAgent({ runId, action: 'command', type, params, fileB64 });
    const rec = await pr; activeRunId = null;
    if (!rec) return json(res, { ok: false, reason: 'agent 执行超时或离线' });
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'relay:command', detail: { type, ok: rec.feedback.ok, text: rec.feedback.text, params } }));
    return json(res, { ok: true, record: toClient(rec) });
  }

  const retryMatch = p.match(/^\/api\/command\/(\d+)\/retry$/);
  if (m === 'POST' && retryMatch) {
    if (!state.connected) return json(res, { ok: false, reason: '设备未连接' });
    if (!agentRes) return json(res, { ok: false, reason: 'agent 离线' });
    const rec = results.find(r => r.id == retryMatch[1]);
    if (!rec) return json(res, { ok: false, reason: '记录不存在' });
    if (rec.type === 'log') {
      const runId = 'run' + (++runSeq); activeRunId = runId; logRunId = runId; state.logRecording = true;
      const pr = new Promise(r => { const t = setTimeout(() => { pendingDone.delete(runId); r(null); }, 30000); pendingDone.set(runId, { resolve: r, timer: t }); });
      pushAgent({ runId, action: 'command', type: 'log', op: 'start' });
      broadcast({ type: 'status', ...state, ip: state.ip });
      const nr = await pr; state.logRecording = false; activeRunId = null;
      broadcast({ type: 'status', ...state, ip: state.ip });
      if (!nr) return json(res, { ok: false, reason: 'log 重试超时' });
      addResult(nr, rec.id);
      return json(res, { ok: true, record: toClient(nr) });
    }
    const runId = 'run' + (++runSeq); activeRunId = runId;
    const pr = new Promise(r => { const t = setTimeout(() => { pendingDone.delete(runId); r(null); }, 120000); pendingDone.set(runId, { resolve: r, timer: t }); });
    pushAgent({ runId, action: 'command', type: rec.type, params: rec.params || {}, retryOf: rec.id });
    const nr = await pr; activeRunId = null;
    if (!nr) return json(res, { ok: false, reason: 'agent 执行超时' });
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
    appendLog('events.jsonl', JSON.stringify({ t: new Date().toISOString(), action: 'relay:delete', detail: { id } }));
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

server.listen(PORT, '127.0.0.1', () => console.error('[adb-console relay] listening on http://127.0.0.1:' + PORT + ' (agent token: ' + AGENT_TOKEN + ')'));
