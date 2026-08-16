# dsh-desktop

DeepSeek Harness（DSH）的 macOS 桌面壳（Electron），附带 DSH 源码检出。

## 仓库结构

```
deepseek-harness/   DSH 源码检出（pnpm workspace；构建自包含 host 包的输入）
dsh-desktop/        Electron 桌面壳应用（本仓库的主体，说明见 dsh-desktop/README.md）
```

`dsh-desktop` 应用在构建 / checkout 模式下依赖 `deepseek-harness/`：`scripts/bundle-host.mjs`
按官方 release 流程把 DSH 全部工作区包打成 tarball 并安装为自包含 `host/` 包，
运行时由 Electron 主进程拉起 `host` 中的 `dsh` CLI（`--profile web --port 0`），
页面经 `dsh-app://` 自定义协议 / IPC 桥接访问。

## 安全

凭据一律放 `~/.dsh` 或环境变量，仓库内只写占位符。仓库自带 `.gitignore` 加固与
提交前密钥扫描钩子（`.githooks/pre-commit`），详见 [SECURITY.md](SECURITY.md)。

## 快速开始

```bash
# deepseek-harness/ 首次使用：安装依赖并构建（打包 host 包时才需要）
cd deepseek-harness && pnpm install && pnpm build:lib && pnpm build:web && cd ..

# dsh-desktop/ 应用
cd dsh-desktop
npm install
npm start            # 编译 + 启动（IPC 模式，checkout 宿主）
npm run bundle:host  # 构建自包含 host 包（可选）
```

详见 [dsh-desktop/README.md](dsh-desktop/README.md)。
