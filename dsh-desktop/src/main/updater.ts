/**
 * 自动更新（GitHub Releases，D4）。
 *
 * 当前为"无证书自用"分发：macOS 上 electron-updater 要求应用已签名
 * （zip 更新要过 Gatekeeper），因此默认不启用。签名/公证后设置环境变量
 * DSH_DESKTOP_UPDATER=1（或改为默认开启）即可启用；publish 源在
 * electron-builder.yml / package.json repository 中配置。
 */
import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

export interface UpdaterHandle {
  /** 菜单"检查更新"入口：未启用时提示。 */
  checkForUpdates: () => Promise<void>
  /** 是否已启用（打包 + 显式开关）。 */
  enabled: boolean
}

export function setupUpdater(): UpdaterHandle {
  const enabled = app.isPackaged && process.env.DSH_DESKTOP_UPDATER === '1'
  let checking = false

  if (enabled) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', async (info) => {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `DeepSeek Harness ${info.version} 可用`,
        detail: '是否现在下载并安装？',
        buttons: ['下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (result.response === 0) {
        void autoUpdater.downloadUpdate()
      }
    })
    autoUpdater.on('update-downloaded', async () => {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: '新版本已下载完成',
        detail: '重启应用以完成安装。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
    autoUpdater.on('error', (error) => {
      console.error('[updater]', error)
    })
  }

  return {
    enabled,
    async checkForUpdates(): Promise<void> {
      if (!enabled) {
        await dialog.showMessageBox({
          type: 'info',
          title: '自动更新未启用',
          message: '当前为未签名自用构建。',
          detail: '签名/公证并设置 DSH_DESKTOP_UPDATER=1 后启用 GitHub Releases 自动更新。',
        })
        return
      }
      if (checking) return
      checking = true
      try {
        await autoUpdater.checkForUpdates()
      } catch (error) {
        console.error('[updater] check failed:', error)
      } finally {
        checking = false
      }
    },
  }
}
