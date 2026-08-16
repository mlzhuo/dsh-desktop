/**
 * 构建自包含 DSH host 包（host/ 目录）——不再依赖本地源码检出。
 *
 * 复刻仓库官方 release 流程（scripts/release/pack.ts + verify-packed-install.ts）：
 *   1. pnpm release:pack --family dsh / vendor  → 全部工作区包打成 tarball；
 *   2. 在 host/ 下写 package.json，把所有 tarball 声明为 file: 依赖；
 *   3. npm install（--omit=optional，与官方一致：跳过 landlock 等平台可选包）；
 *   4. 清理 tarball，校验关键产物（CLI、前端 dist、agent-presets）。
 *
 * 产物布局（随 .app 一起分发，运行时从 Contents/Resources/host 启动）：
 *   host/
 *   ├─ package.json
 *   └─ node_modules/
 *        └─ @deepseek-ai/
 *             ├─ dsh/lib/bin.js            ← 宿主 CLI 入口
 *             ├─ dsh-web-frontend/dist/    ← Web 前端
 *             ├─ dsh-base, dsh-web-app …   ← profile bundles
 *             └─ …（58+ 工作区包与全部外部依赖）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const HOST_DIR = join(PROJECT_ROOT, 'host')
const TARBALL_DIR = join(HOST_DIR, '_tarballs')
const TARBALL_DIR_DSH = join(HOST_DIR, '_tarballs-dsh')
const TARBALL_DIR_VENDOR = join(HOST_DIR, '_tarballs-vendor')
// 默认检出 = 仓库内与 dsh-desktop/ 平级的 deepseek-harness/（相对解析，克隆位置无关）
const CHECKOUT = process.env.DSH_CHECKOUT ?? resolve(PROJECT_ROOT, '..', 'deepseek-harness')

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}  (cwd=${cwd})`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env })
}

function main() {
  if (!existsSync(join(CHECKOUT, 'pnpm-workspace.yaml'))) {
    throw new Error(`DSH checkout 不存在：${CHECKOUT}（可用 DSH_CHECKOUT 覆盖）`)
  }
  rmSync(HOST_DIR, { recursive: true, force: true })
  // pack.ts 每次运行会清空输出目录，因此两族必须分目录打包
  mkdirSync(TARBALL_DIR_DSH, { recursive: true })
  mkdirSync(TARBALL_DIR_VENDOR, { recursive: true })

  // 1. 打包两族（dsh + vendor）到各自目录
  run('node', ['--import', 'tsx/esm', join(CHECKOUT, 'scripts', 'release', 'pack.ts'), '--family', 'dsh', '--out', TARBALL_DIR_DSH], CHECKOUT)
  run('node', ['--import', 'tsx/esm', join(CHECKOUT, 'scripts', 'release', 'pack.ts'), '--family', 'vendor', '--out', TARBALL_DIR_VENDOR], CHECKOUT)

  // 2. 合并两族 tarball，全部声明为 file: 依赖（包名从 tarball 内 package.json 读取）
  const tarballs = [
    ...readdirSync(TARBALL_DIR_DSH).filter((name) => name.endsWith('.tgz')),
    ...readdirSync(TARBALL_DIR_VENDOR).filter((name) => name.endsWith('.tgz')),
  ].sort()
  if (tarballs.length === 0) throw new Error('no tarballs produced')
  const packageNameOf = (file) => {
    const json = execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' })
    return JSON.parse(json).name
  }
  const dependencies = {}
  for (const tarball of tarballs) {
    const source = existsSync(join(TARBALL_DIR_DSH, tarball)) ? TARBALL_DIR_DSH : TARBALL_DIR_VENDOR
    const name = packageNameOf(join(source, tarball))
    if (name in dependencies) {
      throw new Error(`duplicate tarball name ${name}`)
    }
    dependencies[name] = `file:./_tarballs/${tarball}`
  }
  // 合并到统一 tarball 目录，便于 npm 解析相对路径
  mkdirSync(TARBALL_DIR, { recursive: true })
  for (const tarball of tarballs) {
    const source = existsSync(join(TARBALL_DIR_DSH, tarball)) ? TARBALL_DIR_DSH : TARBALL_DIR_VENDOR
    execFileSync('cp', [join(source, tarball), join(TARBALL_DIR, tarball)])
  }
  rmSync(TARBALL_DIR_DSH, { recursive: true, force: true })
  rmSync(TARBALL_DIR_VENDOR, { recursive: true, force: true })

  writeFileSync(join(HOST_DIR, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-host',
    version: '0.0.0',
    private: true,
    dependencies,
  }, null, 2) + '\n')

  // 3. 安装。注意不能加 --omit=optional：koffi 的 darwin 预编译二进制是
  //    optionalDependencies（os/cpu 约束），跳过会导致 koffi 走源码编译（需 CMake）。
  //    npm 会自动跳过不匹配平台的 optional 包（如 landlock-linux-*），macOS 无副作用。
  run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], HOST_DIR)

  // 4. 清理 + 校验
  rmSync(TARBALL_DIR, { recursive: true, force: true })
  const cli = join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dist = join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  const presets = join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets')
  for (const [label, path] of [['CLI', cli], ['前端 dist', dist], ['agent-presets', presets]]) {
    if (!existsSync(path)) throw new Error(`host 包缺少 ${label}：${path}`)
    console.log(`[host] ${label} OK: ${path}`)
  }
  console.log(`[host] bundle 完成：${HOST_DIR}`)
}

main()
