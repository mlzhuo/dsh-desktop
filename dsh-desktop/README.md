# DSH Desktop（macOS）

DeepSeek Harness（DSH）的 macOS 桌面壳：Electron 应用，双击即用，无需手动起服务 / 开浏览器。

## 仓库结构

本仓库包含两个项目（本应用依赖 DSH 源码检出）：

```
deepseek-harness/   DSH（DeepSeek Harness）源码检出（pnpm workspace，构建 host 包的输入）
dsh-desktop/        本应用（Electron 桌面壳，即当前目录）
```

## 特性

- **Electron 壳引导 DSH host 子进程**（与 `dsh web` 完全相同的运行时，`--port 0` 由 OS 分配端口）；
- **自包含 host 包（默认，打包版）**：`scripts/bundle-host.mjs` 按官方 release 流程把 DSH 全部产物（CLI、58+ 工作区包、前端 dist、agent-presets）打进 App 的 `Contents/Resources/host`，**运行时完全不依赖本地源码检出**；开发模式仍可用 `DSH_HOST_SOURCE=checkout` 跑源码；
- **IPC 载体（默认）**：页面加载 `dsh-app://app/` 自定义协议，静态资源与 `/api` 单发请求由主进程代理到回环 host；mux/host 事件流由 preload WebSocket shim 经 IPC 转发——渲染进程全程不触碰回环网络；
- **HTTP 兜底模式**：`DSH_TRANSPORT=http` 直接加载 `http://127.0.0.1:<port>`（调试用）；
- **native seam**：目录选择、打开路径 / 文件 / 外链走 Electron 原生能力；
- **生命周期**：单实例、宿主崩溃检测 + 一键重启、退出时优雅停机、日志落盘；启动失败在窗口内显示原因（可重试）；
- **macOS 集成**：应用菜单、Dock、Web 通知自动映射到通知中心；
- **打包**：electron-builder 出 unsigned `.app` / `.dmg` / `.zip`（**仅 arm64**）；
- **更新**：GitHub Releases 更新管线已接线（签名 / 公证后启用）。

## 前置条件

- **运行时**：Node.js ≥ 22.19（宿主要求 `^22.19.0 || >=24.0.0`；Finder 启动也能自动解析 nvm / homebrew 路径，可用 `DSH_NODE` 覆盖）；
- **构建时**：DSH 源码检出（仓库内 `deepseek-harness/`，默认按相对路径解析，可用 `DSH_CHECKOUT` 覆盖），已执行过 `pnpm install`、`pnpm build:lib`、`pnpm build:web`；仅打包时需要，运行时不需要。

## 安装与运行

```bash
cd dsh-desktop
npm install          # 首次：安装 electron（含二进制下载）
npm start            # 编译 + 启动（IPC 模式，checkout 宿主）
npm run start:bundle # 用项目内 host/ 包运行（构建 host 包后）
npm run start:http   # HTTP 兜底模式
```

启动后窗口即 DSH Web GUI；宿主进程退出时应用会弹窗提供"重启宿主 / 退出"。

## 构建自包含 host 包（不依赖本地源码）

```bash
npm run bundle:host  # 复刻官方 release 流程：pack 全部工作区包 → npm install → host/
# 产物 host/（~700MB）随 .app 一起分发，运行时从 Contents/Resources/host 启动
```

## 打包（无证书自用，仅 arm64）

```bash
npm run pack:dir     # 快速验证：release/mac-arm64/DeepSeek Harness.app（未签名）
npm run dist         # arm64 的 .dmg + .zip（未签名）
```

`electron-builder.yml` 中 `mac.identity: null` 产出未签名应用——本机直接双击可运行；分发给他人会被 Gatekeeper 拦截，需右键打开（签名 / 公证是后续步骤，见下）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOST_SOURCE` | 打包版 `bundle`，开发 `checkout` | `bundle`（App 内 host 包）／`checkout`（源码检出） |
| `DSH_CHECKOUT` | 仓库内 `deepseek-harness/`（相对解析） | DSH 源码检出目录（仅 checkout 模式 / 构建 host 包时用） |
| `DSH_HOST_BUNDLE` | 打包版 `Resources/host`，开发 `./host` | host 包目录（bundle 模式） |
| `DSH_HOME` | `~/.dsh` | DSH 数据目录（会话 / 凭证 / profile，沿用现有数据） |
| `DSH_TRANSPORT` | `ipc` | `ipc`（自定义协议 + IPC 事件桥）／`http`（直连回环） |
| `DSH_NODE` | 自动解析（PATH → nvm → homebrew） | 宿主 Node 可执行文件绝对路径 |
| `DSH_DESKTOP_UPDATER` | 未设置 | `1` 时启用自动更新（需已签名构建） |

## 架构

```
[Electron 主进程]
 ├─ HostManager        spawn host：
 │                     · bundle 模式：`node <app>/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`
 │                     · checkout 模式：`node --import tsx/esm <checkout>/apps/cli/src/bin.ts`
 │                     统一 `--profile web --port 0`；解析就绪行 `dsh web: http://127.0.0.1:PORT`
 ├─ node-path.ts       Finder 环境下解析 node 绝对路径（nvm / homebrew）
 ├─ protocol.ts        `dsh-app://app/` 特权 scheme：页面所有请求代理到回环 host（剥离 Origin/sec-fetch*）
 ├─ ipc.ts             事件流桥（主进程持有宿主 WS，帧转发给渲染进程）+ native seam
 ├─ menu.ts / updater.ts
 └─ before-quit        优雅停机（SIGTERM → SIGKILL 兜底）
[preload]              WebSocket shim：`new WebSocket(ws://dsh-app/…)` → IPC 订阅/帧转发
[渲染进程]             dsh-app://app/ 加载 DSH Web 前端（file 级同源，无网络面）
```

## 目录结构

```
src/
 ├─ main/             主进程（入口 index.ts + host/protocol/ipc/menu/updater/node-path）
 └─ preload/          WebSocket shim + 通用辅助（重试/退出/信息）
scripts/
 ├─ bundle-host.mjs   构建自包含 host 包（pack 全部工作区包 → npm install → host/）
 └─ after-pack.cjs    electron-builder 钩子：把 host/ 整目录复制进 .app 的 Resources/host
host/                 自包含 host 包（~700MB，bundle-host.mjs 生成，gitignore）
resources/icon.png    占位应用图标（可替换）
electron-builder.yml  打包配置（unsigned、arm64 dmg/zip、afterPack、GitHub publish 占位）
```

## 后续（待办）

- [ ] 签名 + 公证（Developer ID），启用自动更新（`DSH_DESKTOP_UPDATER=1`）；
- [ ] 深度链接 `dsh://`（打开会话 / 工作区）；
- [ ] 真 · IPC fetch 载体（`AbstractApiClient` 的 `doFetch` IPC 子类，替换协议代理路径）；
- [ ] host 包瘦身（排除 src/、测试夹具等，当前 ~700MB）。
