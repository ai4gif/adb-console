// scripts/sync.js — 把共享模块与 adb 二进制同步进 desktop 工程（构建前执行）。
// 单一来源在 adb-console 根目录（adb-core.js / agent-lib.js）与系统 adb 二进制。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // adb-console/
const DESK = path.resolve(__dirname, '..');          // adb-console/desktop/

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('sync  ' + src + '  ->  ' + dest);
}

// 1) 共享逻辑（agent-lib 依赖 adb-core，二者一起拷）
copy(path.join(ROOT, 'adb-core.js'), path.join(DESK, 'lib', 'adb-core.js'));
copy(path.join(ROOT, 'agent-lib.js'), path.join(DESK, 'lib', 'agent-lib.js'));

// 2) adb 二进制（macOS 用 /usr/local/bin/adb；可用 ADB_SRC 覆盖）
const ADB_SRC = process.env.ADB_SRC || '/usr/local/bin/adb';
if (!fs.existsSync(ADB_SRC)) {
  console.error('[sync] 警告：未找到 adb 二进制 ' + ADB_SRC + '，请先安装或设置 ADB_SRC');
  process.exit(1);
}
const adbDest = path.join(DESK, 'resources', 'adb', 'adb');
copy(ADB_SRC, adbDest);
fs.chmodSync(adbDest, 0o755);
console.log('[sync] adb 已设为可执行');
