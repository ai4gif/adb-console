# ADB Console 桌面 Agent（macOS 版）

路线 A / 模式 Y 的边缘执行端打包成品：双击运行，后台反向连接中继（relay），在**本机**执行 `adb` 操控同网设备。无需在本机预装 adb（已内置二进制），无需 VPN。

## 构建步骤
```bash
npm install                 # 安装 electron + electron-builder
npm run sync               # 同步共享模块(adb-core/agent-lib)与 adb 二进制
npm run dist:mac           # 产出未签名 zip（dist/ADB Console Agent-x.x.x-mac.zip）
```

> `npm run sync` 会把仓库根的 `adb-core.js` / `agent-lib.js` 与系统 `/usr/local/bin/adb` 拷入本工程，确保单一来源。
> 注：macOS 目标用 `zip`（而非 `dmg`），因为打包机环境无法挂载 `hdiutil`。解压后直接得到 `.app`。

## 使用
1. 解压 `dist/*.zip`，把 `ADB Console Agent.app` 拖到「应用程序」。
2. 首次打开会触发 Gatekeeper，见下方「无法验证开发者」处理。
3. 在窗口填入中继地址（如 `https://你的中继域名`）与 Agent 令牌 → 连接。
4. 关闭窗口后 agent 仍在托盘运行；退出请右键托盘 → 退出。

## 「无法验证开发者」怎么办（macOS 未签名必现）
双击后弹出「无法验证开发者」「无法打开，因为无法验证开发者」属正常——这是 Gatekeeper 对未公证应用的拦截。**不用**去系统设置里找（有时按钮不出现），用下面任一方法放行：

**方法一（最稳，推荐）：右键打开**
- 在 Finder 里**右键** `ADB Console Agent.app` → 选「打开」。
- 弹出的对话框里会出现蓝色的「打开」按钮，点它即可。以后就能正常双击启动了。

**方法二：系统设置放行**
- 双击被拦后，打开「系统设置 → 隐私与安全性」。
- 滚到最下方「安全性」区域，会出现「`ADB Console Agent.app` 已被拦截」及「仍要打开」按钮，点它。
- 若没看到该按钮：先关闭弹窗，再回到 Finder 双击一次触发拦截，然后立刻回设置页查看（按钮有时需重新触发才出现）。

**方法三：命令行清除扩展属性（一键）**
```bash
sudo xattr -cr /Applications/ADB\ Console\ Agent.app
```
执行后直接双击即可，不再弹窗。（`xattr -cr` 只是清掉下载带来的 quarantine 标记，不会改动 app 内容。）

**方法四（不推荐，临时关掉 Gatekeeper）**
```bash
sudo spctl --master-disable   # 关闭后任何来源都可开；用完建议 sudo spctl --master-enable 重新开启
```

> 每换一个新版本（新 zip）首次打开都需再放行一次。这是未签名/未公证的固有限制；如需彻底免拦截需购买 Apple 开发者证书做签名+公证（见 `ROADMAP.md`）。

## 传输架构说明（重要）
- 桌面 agent 与 relay 之间**走短 HTTP 轮询**（agent 每 ~1.5s 拉一次指令，relay 每 ~400ms 推一次事件），**不再用 SSE/WebSocket**。原因：公网经 Cloudflare 快速隧道时 SSE 会被整段缓冲、关连接才一次性吐出，导致指令和状态全部失效。轮询全为独立短请求，隧道完美支持。
- 中继（relay.js）需独立部署到公网（见仓库 `ROADMAP.md`）。本地联调时 relay 在 `http://127.0.0.1:4100`；公网演示用 Cloudflare 快速隧道（临时地址，重启即变）。

## 说明
- macOS 版**未做 Apple 签名/公证**（按需求靠手动信任），每发新版首次需手动放行一次。
- Windows 版：`npm run dist:win`（需对应平台或交叉打包 + 代码签名证书规避 SmartScreen）。
