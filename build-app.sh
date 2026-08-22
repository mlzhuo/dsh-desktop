#!/usr/bin/env bash
# =============================================================================
# 一键构建 DeepSeek Harness 桌面应用（harness 源码 → host 包 → .app）
#
# 用法（在仓库根目录）：
#   ./build-app.sh            # 构建未签名 .app（release/mac-arm64/DeepSeek Harness.app）
#   ./build-app.sh dist       # 额外产出 arm64 的 .dmg + .zip
#   DSH_CHECKOUT=... ./build-app.sh   # 用其他 DSH 源码检出目录
#
# 三条硬保证：
#   1) 绝不动源码 —— 全程没有任何 git checkout/reset/stash/clean 操作；
#      harness 安装用 --frozen-lockfile，lockfile 与源码不一致会直接报错而非改写。
#   2) 绝不留旧产物 —— harness 先 pnpm clean（仅删 lib/、*.tsbuildinfo 等构建产物，
#      删前会校验不会越过仓库边界），再全量重建；host/、dist/、release/ 全部重建；
#      tsc -b 的增量状态（*.tsbuildinfo）一并清掉，杜绝“增量跳过 → 打包旧代码”。
#   3) 构建后自动校验 —— 逐字节比对 host 包内前端 dist 与刚构建出的
#      apps/web/dist，不一致立即失败并退出非零，杜绝“打包进了旧前端”。
# =============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${DSH_CHECKOUT:-$ROOT/deepseek-harness}"
DESKTOP="$ROOT/dsh-desktop"
MODE="${1:-app}"
SECONDS=0

# v0.1.1+ 官方构建档案：release 打包（bundle:host 的 pack.ts）会校验
# .dsh-build/client-build-environment.json 必须匹配 official 档案
# （DSH_CLIENT_BUILD_PROFILE=official + DSH_CLIENT_TITLE=DeepSeek Harness）；
# 未设置时 `pnpm build` 会写入 local 档案导致打包失败。DSH_CLIENT_COMMIT_HASH
# 由 build 脚本自动取自 git HEAD，无需手动设置。
export DSH_BUILD_CLIENT_PROFILE=official

# ---------- 工具链 ----------
if ! command -v node >/dev/null 2>&1; then
  # Finder / 非交互 shell 常没有 nvm 的 PATH，兜底取最新安装的 nvm node
  if [ -d "$HOME/.nvm/versions/node" ]; then
    latest="$(ls "$HOME/.nvm/versions/node" | sort -V | tail -n 1)"
    export PATH="$HOME/.nvm/versions/node/$latest/bin:$PATH"
  fi
fi
command -v node >/dev/null 2>&1 || { echo "!! 找不到 node（可在 PATH 或 nvm 安装后重试）" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "!! 找不到 pnpm（corepack 启用或安装后重试）" >&2; exit 1; }

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "!! 需要 Node >= 24（harness 要求 ^22.19 || >=24，当前 $(node -v)）" >&2
  exit 1
fi

[ -f "$HARNESS/pnpm-workspace.yaml" ] || { echo "!! DSH 检出不存在：$HARNESS" >&2; exit 1; }
[ -f "$DESKTOP/package.json" ] || { echo "!! 桌面应用目录不存在：$DESKTOP" >&2; exit 1; }

# ---------- 互斥锁：避免两个构建同时跑；残留锁（进程已死）自动清理 ----------
LOCK_DIR="/tmp/dsh-desktop-build.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -f "$LOCK_DIR/pid" ] && ! kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
    echo "!! 清理过期构建锁（残留进程 $(cat "$LOCK_DIR/pid" 2>/dev/null) 已不在运行）"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR"
  else
    echo "!! 已有构建正在进行（${LOCK_DIR}）；如确认无其他构建，请先 rm -rf $LOCK_DIR" >&2
    exit 1
  fi
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT
trap 'echo "!! 构建失败（第 $LINENO 行，退出码 $?）—— 请查看上方日志定位失败阶段" >&2' ERR

phase() { echo; echo "==> [$1] $2"; }

echo "==> DeepSeek Harness 一键构建（$MODE 模式，开始于 $(date '+%H:%M:%S')）"
echo "    harness : $HARNESS"
echo "    desktop : $DESKTOP"
echo "    node    : $(node -v)  pnpm: $(pnpm -v)"

# ---------- 1. harness：安装依赖（frozen，不改写 lockfile） ----------
phase harness "pnpm install --frozen-lockfile"
pnpm -C "$HARNESS" install --frozen-lockfile

# ---------- 2. harness：清掉全部构建产物与增量状态 ----------
phase harness "pnpm clean（仅删 lib/ 与 *.tsbuildinfo 等产物，不触碰源码）"
pnpm -C "$HARNESS" clean

# ---------- 3. harness：从当前源码全量重建（lib + web 前端） ----------
phase harness "pnpm build（= build:lib + build:web）"
pnpm -C "$HARNESS" build

# ---------- 4. desktop：清空编译输出并重编 Electron 壳 ----------
phase desktop "清空 dist 并编译 Electron 壳"
rm -rf "$DESKTOP/dist"
npm --prefix "$DESKTOP" run build

# ---------- 5. desktop：整体重建自包含 host 包 ----------
phase desktop "bundle:host（host/ 整体重建，tarball 取自刚构建的 lib/dist）"
npm --prefix "$DESKTOP" run bundle:host

# ---------- 6. 校验：host 包里的前端必须与源码刚构建的一致 ----------
phase verify "host 包前端 dist 与 apps/web/dist 逐字节比对"
SRC_WEB_DIST="$HARNESS/apps/web/dist"
HOST_WEB_DIST="$DESKTOP/host/node_modules/@deepseek-ai/dsh-web-frontend/dist"
if [ ! -d "$HOST_WEB_DIST" ] || ! diff -rq -x '*.map' "$SRC_WEB_DIST" "$HOST_WEB_DIST" >/dev/null 2>&1; then
  echo "!! host 包前端与 apps/web/dist 不一致 —— 旧产物被混入，构建终止" >&2
  echo "    源:      $SRC_WEB_DIST" >&2
  echo "    host 内: $HOST_WEB_DIST" >&2
  echo "    （*.map 源映射按发布配置不入包，比对时已排除）" >&2
  exit 1
fi
echo "    前端 dist 一致 ✓"

# ---------- 7. 打包 .app（dist 模式再出 dmg/zip） ----------
if [ "$MODE" = "dist" ]; then
  phase pack "electron-builder：arm64 .dmg + .zip"
  npm --prefix "$DESKTOP" run dist
else
  phase pack "electron-builder：未签名 .app（pack:dir）"
  rm -rf "$DESKTOP/release"
  npm --prefix "$DESKTOP" run pack:dir
fi

APP="$DESKTOP/release/mac-arm64/DeepSeek Harness.app"
[ -d "$APP" ] || { echo "!! 未找到构建产物：$APP" >&2; exit 1; }
[ -f "$APP/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
  && echo "    App 内 host CLI ✓"

echo
echo "✓ 构建完成（$(date '+%H:%M:%S')，用时 ${SECONDS}s）：$APP"
