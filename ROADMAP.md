# ADB 控制台 · 分布式架构路线图（路线 A / 模式 Y）

## 目标形态
任何电脑 / 手机打开网页（云端 relay）→ 穿透用户家庭 NAT → 用户本机运行的桌面小程序（agent）实际执行 `adb` → 回控同局域网设备。

> 浏览器与云服务器都跑不了 `adb`（它是原生二进制），所以真正执行 `adb` 的主体必须是**用户自己电脑（或同网段机器）上的一个本地 agent**；云上只放「网站 UI + 信令中转」。

## 组件
| 文件 | 角色 | 职责 |
|---|---|---|
| `relay.js` | 云端中继 | 托管 UI + 浏览器 SSE + 浏览器 API；把指令转发给已连接的 agent（反向 SSE），把 agent 回传的结果经 SSE 推回浏览器。**自身不执行 adb**。 |
| `agent.js` | 边缘执行端 | 反向连接 relay；本地执行 `adb` 操控同网设备；回传 stdout 流与截图/日志（base64）。未来打包成 Win / macOS 双版本桌面小程序。 |
| `adb-core.js` | 共享模块 | DANGER 拦截、IP 校验、`adb` spawn / 流式读取；relay 与 agent 共用。 |
| `server.js` | 单机型（旧） | UI + adb 一体，用于本机直连，保留兼容。 |
| `index.html` | 浏览器 UI | 连 relay（同源自带 `API=''`），填设备 IP、看结果；与 `server.js` / `relay.js` 同契约。 |

## 通信协议
1. **agent 上线**：`GET /api/agent/stream?agentToken=xxx`（SSE）→ relay 标记 online 并归属。
2. **指令下行**：浏览器 `POST /api/command` → relay 经 agent SSE 推 `{runId, action:'command', type, params, fileB64}`。
3. **结果上行**：agent `POST /api/agent/result`（chunk / done / logline）→ relay 经浏览器 SSE 推 `cmd` / `done` / `log` 事件。

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

## Stage 1（待做）
- agent 用 Electron 打包 Win(`.exe`) / macOS(`.dmg`) 双版本，内置 `adb` 二进制；macOS 不签名、靠用户手动信任。
- relay 部署到云服务器 + 固定域名 + HTTPS（Cloudflare named tunnel 或自有域名反代）。
- 多用户账号系统 + 操作审计、设备自动发现、危险指令在 agent 端也拦截。
