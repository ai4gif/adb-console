# ADB Console 桌面 Agent（macOS 版）

路线 A / 模式 Y 的边缘执行端打包成品：双击运行，后台反向连接中继（relay），在**本机**执行 `adb` 操控同网设备。无需在本机预装 adb（已内置二进制），无需 VPN。

## 构建步骤
```bash
npm install                 # 安装 electron + electron-builder
npm run sync               # 同步共享模块(adb-core/agent-lib)与 adb 二进制
npm run dist:mac           # 产出未签名 dmg（dist/ADB Console Agent-x.x.x.dmg）
```

> `npm run sync` 会把仓库根的 `adb-core.js` / `agent-lib.js` 与系统 `/usr/local/bin/adb` 拷入本工程，确保单一来源。

## 使用
1. 双击 `dist/*.dmg` → 拖入「应用程序」。
2. 首次打开若提示「无法验证开发者」：系统设置 → 隐私与安全性 → 仍要打开（或 Finder 右键打开 / `sudo xattr -cr /Applications/ADB\ Console\ Agent.app`）。
3. 在窗口填入中继地址（如 `https://你的中继域名`）与 Agent 令牌 → 连接。
4. 关闭窗口后 agent 仍在托盘运行；退出请右键托盘 → 退出。

## 说明
- macOS 版**未做 Apple 签名/公证**（按需求靠手动信任），每发新版首次需手动放行一次。
- 中继（relay.js）需独立部署到公网（见仓库 `ROADMAP.md`）。
- Windows 版：`npm run dist:win`（需对应平台或交叉打包 + 代码签名证书规避 SmartScreen）。
