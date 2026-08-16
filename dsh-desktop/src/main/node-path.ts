/**
 * 解析宿主可用的 Node 可执行文件绝对路径。
 *
 * Finder 双击启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，nvm / homebrew
 * 的 node 都不在其中；`spawn('node')` 会 ENOENT。这里在运行时按优先级解析：
 *
 *   1. DSH_NODE 环境变量（显式覆盖）
 *   2. 扩展 PATH（含 /opt/homebrew/bin、/usr/local/bin）里的 node
 *   3. nvm 版本目录（~/.nvm/versions/node 下各版本 bin/node，最高版本优先）
 *   4. /usr/bin/node（Xcode CLT 自带，通常过旧——仅当满足 engines 才接受）
 *
 * 每个候选执行 `node --version` 校验，满足 DSH engines（^22.19.0 || >=24.0.0）
 * 即返回；都不满足返回 undefined，由调用方给出明确错误。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/** 校验版本是否满足 DSH engines：^22.19.0 || >=24.0.0。 */
function satisfiesEngines(versionLine: string): boolean {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(versionLine.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor >= 19
  return major >= 24
}

function candidates(): string[] {
  const list: string[] = []
  const push = (path: string): void => {
    if (path.length > 0 && !list.includes(path)) list.push(path)
  }
  const env = process.env.DSH_NODE
  if (env !== undefined && env.length > 0) push(env)

  const pathDirs = (process.env.PATH ?? '').split(':').concat(EXTRA_PATH_DIRS)
  for (const dir of pathDirs) {
    if (dir.length === 0) continue
    const p = join(dir, 'node')
    if (existsSync(p)) push(p)
  }

  const nvmRoot = process.env.NVM_DIR ?? join(homedir(), '.nvm')
  const versionsDir = join(nvmRoot, 'versions', 'node')
  if (existsSync(versionsDir)) {
    const versions = readdirSync(versionsDir).sort().reverse() // 最高版本优先
    for (const version of versions) {
      const p = join(versionsDir, version, 'bin', 'node')
      if (existsSync(p)) push(p)
    }
  }
  return list
}

/** 返回满足 engines 的 node 绝对路径；找不到返回 undefined。 */
export function resolveNodeBinary(): string | undefined {
  for (const candidate of candidates()) {
    try {
      const out = execFileSync(candidate, ['--version'], { stdio: 'pipe', timeout: 5_000 }).toString()
      if (satisfiesEngines(out)) return candidate
    } catch {
      // 候选不可执行或过旧 → 尝试下一个
    }
  }
  return undefined
}
