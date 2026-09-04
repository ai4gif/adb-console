# ADB 网页控制台

浏览器里跑不了 `adb`，本控制台把命令执行放到**后端（装了 adb 且能访问设备的机器）**，前端只发请求、回显结果。已用真实设备验证。

## 启动

```bash
cd adb-console
npm start            # 等价于 node server.js，默认端口 3000
# 自定义端口： PORT=8080 npm start
```

打开 **http://127.0.0.1:3000** （务必用这个地址，不要直接双击 `index.html`，`file://` 下前端无法调用后端）。

## 设备侧准备

设备需先开无线调试（通常 USB 连一次后执行）：

```bash
adb tcpip 5555
```

确保运行本服务的机器与设备在同一网段、能 ping 通 `IP:5555`。

## 已实现并真机验证

- 连接：IP 卡片的「连接」按钮为**连接/断开切换**——连上后变为「断开」，点击即断开（无二次确认）；指示灯 灰/黄(连接中)/绿/红，失败显示 adb 真实原因并给出针对性排查提示（连接拒绝/离线/未授权/网络不可达）；10s 超时防卡死。顶部不再单独显示状态药丸。
- 设备发现：点「扫描设备」调用 `adb devices -l`，列出本机已连设备（在线/离线/未授权）并一键填入 IP，免去手工查 `adb devices`。
- 打 log：`adb logcat` 实时采集，停止后落盘 `logN.txt`。
- 安装应用：上传 `.apk` → `adb install -r`，**实时回显**安装过程输出。
- 删除应用：`adb uninstall <pkg>`，**实时回显**卸载过程输出。
- 截屏：写入设备临时文件 → `adb pull` → 清理（避开网络 adb `exec-out` 流式截屏的 `error: closed` 坑），落盘后图片写入结果列表。
- 自定义：原样执行；首词非 adb 动词时自动补 `shell` 前缀（如 `getprop` → `shell getprop`）；`rm / reboot` 等危险命令被拦截；**实时回显** stdout。
- 指令实时回显：安装/卸载/自定义三类指令边跑边通过 SSE 的 `cmd` 事件推到独立的「执行回显」窗口（截屏瞬时完成只给最终结果，logcat 走自身实时日志）。
- 停止：执行安装/卸载/自定义时，执行按钮右侧出现「停止」按钮，可中途终止正在运行的 adb 子进程（logcat 仍用「执行」按钮再点一次停止）。
- 结果列表：执行时间精确到**分钟**（`YYYY-MM-DD HH:MM`）；支持**删除**单条记录（同时删除其产物文件，二次确认）；图片点开预览、右键下载，文本/APK 点击即预览/下载（去掉了单独的预览/下载按钮）。
- 交互细节：按钮 `:active` 按压反馈；底部居中版权 `Copyright@2026byLuCien`。

## 架构

零依赖：Node 内置 `http` 替代 Express，`SSE (/api/stream)` 替代 WebSocket 推送状态/日志，apk 上传走原始二进制 body 替代 multer。

```
浏览器 ──fetch/SSE──> 后端(server.js) ──child_process──> adb ──> 设备
```

## 可选访问令牌（安全）

默认**完全开放**（同机/内网可用）。若部署到不信任网络，设置环境变量开启 Bearer 令牌鉴权：

```bash
ADB_CONSOLE_TOKEN=你的强令牌 npm start
```

开启后：

- 所有 `/api/*` 请求须带 `Authorization: Bearer <token>`（SSE 流可用 `?token=<token>` 查询参数）。
- 前端首次访问若后端返回 401，会自动弹出令牌输入框；输入正确后存入 `sessionStorage` 并自动重连。
- 未带/错误令牌一律返回 `401 unauthorized`，`/api/stream` 直接断开。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/status`        | 当前连接状态 |
| GET  | `/api/devices`       | 本机已连设备列表（`adb devices -l` 解析，含 state/extra） |
| POST | `/api/connect`       | `{ip}` 连接设备（10s 超时），失败返回 `reason`+`hint` |
| POST | `/api/disconnect`    | 断开 |
| POST | `/api/command`       | 执行指令（JSON 或 apk 二进制）；`{type:"log"\|\|"install"\|\|"uninstall"\|\|"screencap"\|\|"custom"}`；install/uninstall/custom 可在请求头带 `X-Run-Id` 以关联 SSE 的 `cmd` 回显流 |
| POST | `/api/command/stop`  | 终止当前正在运行的 install/uninstall/custom 子进程 |
| POST | `/api/command/:id/retry` | 重试某条记录（覆盖不新增） |
| GET  | `/api/results`       | 结果列表（分页 `?page=&size=`） |
| DELETE | `/api/results/:id`  | 删除单条记录并删除其产物文件 |
| GET  | `/api/files/:id`     | 预览/下载产物（`?download=1` 强制下载） |
| GET  | `/api/stream`        | SSE：实时状态、`logcat` 行、以及指令 `cmd` 回显（带 `runId`） |

## 已知限制

- 后端为全局单例连接（同一时刻一台设备）；多用户并发需自行加会话隔离。
- 「停止」通过 `SIGKILL` 终止 adb 子进程，安装/卸载中途停止可能在设备上留下半成品，属预期行为。
- 自定义命令的安全拦截为简单黑名单，生产环境应接白名单/审批。
