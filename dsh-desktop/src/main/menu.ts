/**
 * 应用菜单（macOS）：标准角色 + 桌面壳专属动作。
 */
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export interface MenuDeps {
  getWindow: () => BrowserWindow | null
  dshHome: string
  checkout: string
  logDir: string
  hostSource: 'bundle' | 'checkout'
  onCheckUpdates: () => void
  onRestartHost: () => void
  onOpenHostInBrowser: () => void
}

export function buildMenu(deps: MenuDeps): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: '检查更新…', click: () => deps.onCheckUpdates() },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开 DSH 数据目录（~/.dsh）', click: () => { void shell.openPath(deps.dshHome) } },
        ...(deps.hostSource === 'checkout'
          ? [{ label: '打开 DSH 源码检出目录', click: () => { void shell.openPath(deps.checkout) } }]
          : []),
        { label: '打开宿主日志目录', click: () => { void shell.openPath(deps.logDir) } },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '宿主',
      submenu: [
        { label: '重启 DSH 宿主', click: () => { void deps.onRestartHost() } },
        { label: '在浏览器中打开宿主 URL', click: () => deps.onOpenHostInBrowser() },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'DeepSeek Harness 仓库',
          click: () => { void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  void deps.getWindow // 保持依赖引用（后续可挂窗口相关菜单状态）
}
