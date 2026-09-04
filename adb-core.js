// adb-core.js — 零依赖 adb 执行与工具（relay 与 agent 共用）
// 仅负责「给定指令 → 本地执行 adb → 返回结果」，不管理设备连接状态/会话/记录生命周期
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ADB = process.env.ADB_BIN || 'adb';

const DANGER = /(shell\s+rm\b|shell\s+reboot\b|shell\s+pm\s+clear\b|\brm\s+-rf\b|reboot\b|root\b|wipe\b|format\b|fastboot\b|mkfs\b|dd\s|shell\s+input\b)/i;

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

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
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

function writeArt(artDir, name, buf) {
  const fp = path.join(artDir, name);
  fs.writeFileSync(fp, buf);
  return fp;
}

async function connectDevice(ip) {
  const r = await runAdb(['connect', ip], { timeout: 10000 });
  const out = (r.out || '').toString();
  const success = /connected to/i.test(out);
  let reason = success ? '' : (out || r.err || '连接失败').trim().slice(0, 160);
  let hint = '';
  if (!success && reason) {
    const low = reason.toLowerCase();
    if (/connection refused|failed to connect/i.test(reason)) hint = '目标无响应：确认 IP:端口 正确、设备已执行 adb tcpip 5555、同网段、防火墙未拦 5555。';
    else if (/device offline/i.test(low)) hint = '设备离线：设备上重新执行 adb tcpip 5555 后重试。';
    else if (/unauthorized|device unauthorized/i.test(low)) hint = '设备未授权：在设备屏幕点击「允许 USB 调试」。';
    else if (/host doesn't|cannot connect|timed out|timeout/i.test(low)) hint = '网络不可达：确认设备与本机同一 Wi-Fi，5555 已开。';
  }
  return { ok: success, reason, hint };
}

async function listDevices() {
  const r = await runAdb(['devices', '-l'], { timeout: 8000 });
  const lines = (r.out || '').toString().split(/\r?\n/).filter(Boolean);
  const devs = [];
  for (const ln of lines.slice(1)) {
    const mm = ln.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (mm) devs.push({ id: mm[1], state: mm[2], extra: mm[3] || '' });
  }
  return devs;
}

// 非流式执行（retry / 一次性）：返回 {feedback, output}
async function runCommand(type, params = {}, filePath = null, artDir) {
  if (type === 'install') {
    if (!filePath) return { error: '缺少 apk 文件' };
    const r = await runAdb(['install', '-r', filePath]);
    const detail = (r.out + '\n' + r.err).trim();
    const ok = r.code === 0 && !/Failure/i.test(detail);
    let output = null;
    if (!ok) { const fp = writeArt(artDir, 'error_' + Date.now() + '.txt', detail || 'install failed'); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return { feedback: ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }, output };
  }
  if (type === 'uninstall') {
    const pkg = params.pkg; if (!pkg) return { error: '缺少包名' };
    const r = await runAdb(['uninstall', pkg]);
    const detail = (r.out + '\n' + r.err).trim();
    const ok = r.code === 0 && !/Failure/i.test(detail);
    let output = null;
    if (!ok) { const fp = writeArt(artDir, 'error_' + Date.now() + '.txt', detail || 'uninstall failed'); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return { feedback: ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }, output };
  }
  if (type === 'screencap') {
    const fp = path.join(artDir, 'shot_' + Date.now() + '.png');
    const devPath = '/sdcard/__adb_console_shot.png';
    const r1 = await runAdb(['shell', 'screencap', '-p', devPath], { timeout: 15000 });
    if (r1.code !== 0) return { feedback: { ok: false, text: 'FAILURE: ' + (r1.err || r1.out || 'screencap failed').trim().slice(0, 120) }, output: null };
    await runAdb(['pull', devPath, fp], { timeout: 15000 });
    await runAdb(['shell', 'rm', devPath]);
    if (!fs.existsSync(fp) || fs.statSync(fp).size === 0) return { feedback: { ok: false, text: 'FAILURE: 截图拉取失败（设备可能无存储权限）' }, output: null };
    return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'image', name: path.basename(fp), filePath: fp } };
  }
  if (type === 'custom') {
    const cmd = (params.cmd || '').trim(); if (!cmd) return { error: '命令为空' };
    if (DANGER.test(cmd)) return { error: '该命令被安全策略禁止执行（危险命令）' };
    const ADB_VERBS = /^(shell|exec-out|exec|install|uninstall|push|pull|forward|reverse|reboot|connect|disconnect|devices|wait-for-device|start-server|kill-server|tcpip|usb|logcat|bugreport|backup|restore|keygen|version|help|get-state|get-serialno|get-devpath|status-window|jdwp|track-devices|emu)\b/;
    const full = ADB_VERBS.test(cmd) ? cmd : ('shell ' + cmd);
    const r = await runAdb(full.split(/\s+/), { timeout: 15000 });
    const content = '$ adb ' + full + '\n' + (r.out || '') + (r.err || '') + 'exit-code: ' + r.code + '\n';
    const fp = writeArt(artDir, 'cmd_out_' + Date.now() + '.txt', content);
    return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name: 'cmd_out.txt', filePath: fp } };
  }
  return { error: '未知指令类型' };
}

// 流式执行：边跑边 onChunk(chunk)；onActive(proc) 暴露进程供停止；返回 {feedback, output, _log?}
async function runCommandLive(type, params = {}, filePath = null, runId = '', artDir, onChunk, onActive) {
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
  } else if (type === 'log') {
    args = ['logcat'];
  } else {
    return { error: '不支持的实时指令' };
  }

  const proc = spawn(ADB, args);
  proc.userStop = false;
  if (onActive) onActive(proc);
  const disp = (type === 'custom' ? ('$ adb ' + full) : (type === 'log' ? '$ adb logcat' : ('$ adb ' + args.join(' '))));
  if (runId && onChunk) onChunk(disp + '\n');
  let out = '', err = '';
  proc.stdout.on('data', d => { const s = d.toString(); out += s; if (runId && onChunk) onChunk(s); });
  proc.stderr.on('data', d => { const s = d.toString(); err += s; if (runId && onChunk) onChunk(s); });
  const code = await new Promise(res => proc.on('close', c => res(c === null ? 1 : c)));

  if (type === 'log') {
    const content = out; // logcat 持续累积到 out，stop 后回传
    let output = null;
    if (content.trim()) { const fp = writeArt(artDir, 'log_' + Date.now() + '.txt', content); output = { kind: 'text', name: 'log.txt', filePath: fp }; }
    return { feedback: proc.userStop ? { ok: false, text: '已停止 (用户终止)' } : { ok: true, text: 'SUCCESS' }, output };
  }

  if (type === 'install' || type === 'uninstall') {
    const detail = (out + '\n' + err).trim();
    const ok = proc.userStop ? false : (code === 0 && !/Failure/i.test(detail));
    let output = null;
    if (!ok && detail) { const fp = writeArt(artDir, 'error_' + Date.now() + '.txt', detail); output = { kind: 'text', name: 'error.txt', filePath: fp }; }
    return {
      feedback: proc.userStop ? { ok: false, text: '已停止 (用户终止)' }
        : (ok ? { ok: true, text: 'SUCCESS' } : { ok: false, text: 'FAILURE: ' + detail.slice(0, 200) }),
      output
    };
  }
  // custom
  if (proc.userStop) return { feedback: { ok: false, text: '已停止 (用户终止)' }, output: null };
  const label = full ? ('$ adb ' + full) : '$ adb';
  const content = label + '\n' + out + (err || '') + 'exit-code: ' + code + '\n';
  const fp = writeArt(artDir, 'cmd_out_' + Date.now() + '.txt', content);
  return { feedback: { ok: true, text: 'SUCCESS' }, output: { kind: 'text', name: 'cmd_out.txt', filePath: fp } };
}

module.exports = { ADB, DANGER, validateIP, nowStr, runAdb, writeArt, connectDevice, listDevices, runCommand, runCommandLive };
