# ADB 控制台 · 分布式架构路线图（路线 A / 模式 Y）

## 目标形态
任何电脑 / 手机打开网页（云端 relay）→ 穿透用户家庭 NAT → 用户本机运行的桌面小程序（agent）实际执行 `adb` → 回控同局域网设备。

> 浏览器与云服务器都跑不了 `adb`（它是原生二进制），所以真正执行 `adb` 的主体必须是**用户自己电脑（或同网段机器）上的一个本地 agent**；云上只放「网站 UI + 信令中转」。

## 组件
| 文件 | 角色 | 职责 |
|---|---|---|
| `relay.js` | 云端中继 | 托管 UI + 浏览器**轮询**（`/api/events`）+ 浏览器 API；把指令放进队列，已连接的 agent **轮询**取走（`/api/agent/poll`）后在本地执行 adb，结果 POST 回 relay 入事件队列，浏览器轮询取回。**自身不执行 adb**。 |
| `agent.js` | 边缘执行端 | 轮询连接 relay（每 ~1.5s `GET /api/agent/poll`）；本地执行 `adb` 操控同网设备；回传 stdout 流与截图/日志（base64）。已打包成 macOS（桌面小程序），Windows 待做。 |
| `adb-core.js` | 共享模块 | DANGER 拦截、IP 校验、`adb` spawn / 流式读取；relay 与 agent 共用。 |
| `server.js` | 单机型（旧） | UI + adb 一体，用于本机直连，保留兼容。 |
| `index.html` | 浏览器 UI | 连 relay（同源自带 `API=''`），轮询 `/api/events` 拉实时状态/日志；与 `relay.js` 同契约。 |

## 通信协议（轮询，非 SSE）
> 早期版本用 SSE（反向 SSE + 浏览器 SSE）。但公网经 Cloudflare 快速隧道时 SSE 会被**整段缓冲、关闭连接才一次性 flush**，导致 agent 收不到指令、网页收不到实时状态——表现为「连接状态一直闪 / 未连接」。故全链路改为短 HTTP 轮询。
1. **agent 上线 / 取指令**：`GET /api/agent/poll?agentToken=xxx&after=<id>` → 返回 `id` 之后的指令数组；每次轮询即心跳，relay 标记 online（超过 15s 未轮询看门狗置 offline）。
2. **指令下行**：浏览器 `POST /api/command` → relay 把 `{runId, action:'command', type, params, fileB64}` 推入指令队列，等 agent 下次轮询取走。
3. **结果上行**：agent `POST /api/agent/result`（chunk / done / logline）→ relay 入事件队列。
4. **浏览器拉状态**：`GET /api/events?after=<id>` → 返回 `id` 之后的事件（status / cmd / log / done）+ 当前 state 快照；`after` 落后过多时返回 `reset:true` 提示整页刷新。

## 本地最小闭环（Stage 0，已验证）
```bash
# 1) 启动 relay（浏览器令牌可选；AGENT_TOKEN 为 agent 凭证）
PORT=4100 node relay.js

# 2) 启动 agent（同机模拟云端，反向连 relay）
RELAY_URL=http://127.0.0.1:4100 AGENT_TOKEN=dev-agent-token node agent.js

# 3) 浏览器打开 http://127.0.0.1:4100 → 填设备 IP → 连接 → 截屏 / 自定义
```

## 已完成验证（本机 172.16.0.108:5555）
- 浏览器 → relay → agent → 真机 全链路连通
- 连接设备、列设备、截屏（真实 PNG 经完整链路回传）、自定义指令流式、停止（SIGKILL 返回「已停止」）、文件回传 `/api/files/:id`
- 无头 Chrome 实测 UI：无令牌弹窗、状态绿灯、结果列表出现截图缩略图且真实加载

## 安全
- relay 端对 `custom`/`shell` 含危险词（rm / reboot / wipe / dd …）的指令做**服务端拦截**（前端也拦，直连 API 仍挡得住）。
- agent 连 relay 需 `AGENT_TOKEN`，防止他人 agent 接走你的指令。
- 公网部署时建议为浏览器访问开启 `ADB_CONSOLE_TOKEN`。

## Stage 1（进行中）
### 1.0 macOS 桌面 agent（已完成，含轮询修复）
- `desktop/` 工程（Electron + electron-builder）：`src/main.js`（托盘 + 配置窗口 + 调 `startAgent`，关窗=最小化托盘）、`preload.js`、`renderer.html/js`（填 relay 地址 + token、显示连接状态）、`scripts/sync.js`（同步仓库根 `adb-core.js`/`agent-lib.js` 与系统 `adb` 二进制，单一来源）、`scripts/make_icon.py`、`README.md`。
- **2026-09-04 修复**：relay / agent / 网页三端 SSE 全部改为轮询，解决 Cloudflare 快速隧道下 agent 一直闪、未连接的问题。重新构建：`npm run dist:mac` → `dist/ADB Console Agent-0.1.0-mac.zip`（约 94MB，未签名，符合「不签名靠手动信任」）。
  - 注：本机打包环境下 `hdiutil` 挂载 `/Volumes` 被沙箱拦截，故 mac 目标用 `zip` 而非 `dmg`；要在自己 Mac 上出 `.dmg` 直接 `npm run dist:mac` 即可。
- 运行：双击 zip 解压 → 拖入「应用程序」→ 首次若提示「无法验证开发者」：系统设置→隐私与安全性→仍要打开（或 `sudo xattr -cr /Applications/ADB\ Console\ Agent.app`）→ 填 relay 地址 + token → 连接。
- 内置 `adb` 二进制在 `Contents/Resources/adb/adb`；共享逻辑在 `Contents/Resources/app.asar`。

### 1.1 Windows 桌面 agent（待做）
- 同工程 `npm run dist:win` → `.exe`（NSIS）；需在 `resources/adb` 放 Windows 版 `adb.exe` + `AdbWinApi.dll` + `AdbWinUsbApi.dll`；建议代码签名证书规避 SmartScreen。

### 1.2 relay 云部署（待做）
- 把 `relay.js` 部署到云服务器 + 固定域名 + HTTPS（Cloudflare named tunnel 或自有域名反代）；`agent.js`/`desktop` 连公网 relay 地址。

### 1.3 后续（待做）
- 多用户账号系统 + 操作审计、设备自动发现、危险指令在 agent 端也拦截。
