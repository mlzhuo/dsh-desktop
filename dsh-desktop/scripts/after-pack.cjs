/**
 * electron-builder afterPack 钩子：把自包含 DSH host 包整目录复制进 .app。
 *
 * 不用 extraResources：它内部的 file filter 会排除 node_modules，
 * 目录型 from 实际只拷出顶层文件。这里用 fs.cpSync 全量复制（保留符号链接），
 * 保证 Contents/Resources/host 与项目 host/ 完全一致。
 */
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context
  const hostSrc = join(packager.projectDir, 'host')
  // macOS 的 appOutDir 是 .app 的父目录（productFilename 即 bundle 名）
  const appBundleDir = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  const hostDst = join(appBundleDir, 'Contents', 'Resources', 'host')

  const cli = join(hostSrc, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) {
    throw new Error(`host 包不完整（缺少 ${cli}）——请先运行 npm run bundle:host`)
  }
  cpSync(hostSrc, hostDst, { recursive: true })
  console.log(`[after-pack] host bundle -> ${hostDst}`)
}
