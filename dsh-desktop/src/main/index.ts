/**
 * DSH Desktop —— Electron 主进程入口。
 *
 * 启动流程：单实例锁 → 注册 dsh-app 特权 scheme → 创建窗口（loading）→
 * 拉起 DSH host 子进程（--port 0）→ 解析就绪端口 → 加载应用页（IPC 模式
 * 走 dsh-app://localhost/，HTTP 兜底模式走 http://127.0.0.1:PORT）。
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HostManager } from './host'
import { registerScheme, registerProtocol, appUrl } from './protocol'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { setupUpdater } from './updater'
import { resolveNodeBinary } from './node-path'

console.log('[desktop] dsh-desktop main entry')

// ---- 环境配置 ----

// 默认检出 = 仓库内与 dsh-desktop/ 平级的 deepseek-harness/（dist/main → 仓库根，相对解析，克隆位置无关）
const CHECKOUT = process.env.DSH_CHECKOUT ?? join(__dirname, '..', '..', '..', 'deepseek-harness')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const TRANSPORT: 'ipc' | 'http' = process.env.DSH_TRANSPORT === 'http' ? 'http' : 'ipc'
const LOG_DIR = app.getPath('logs')

/** 宿主来源：bundle（自包含，打包版默认）／checkout（源码检出，开发默认）。 */
const HOST_SOURCE: 'bundle' | 'checkout' = (
  process.env.DSH_HOST_SOURCE === 'bundle' || process.env.DSH_HOST_SOURCE === 'checkout'
    ? process.env.DSH_HOST_SOURCE
    : app.isPackaged ? 'bundle' : 'checkout'
)
/** bundle 目录：打包版在 Contents/Resources/host；开发版用项目内 host/。 */
const BUNDLE_DIR = process.env.DSH_HOST_BUNDLE ?? (
  app.isPackaged ? join(process.resourcesPath, 'host') : join(__dirname, '..', '..', 'host')
)

// ---- 单实例 ----

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  registerScheme() // 必须在 app ready 之前

  let mainWindow: BrowserWindow | null = null
  let host: HostManager | undefined
  /** 启动早期失败信息：窗口被关闭后再打开时复用展示。 */
  let startupFailure: { message: string; detail: string } | null = null

  const getWindow = (): BrowserWindow | null => mainWindow

  app.on('second-instance', () => {
    ensureWindow()
  })

  const createWindow = (): void => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 620,
      show: false,
      title: 'DeepSeek Harness',
      backgroundColor: '#0f1420',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        // 自用可信内容（宿主伺服的本仓库前端 + 插件 bundle）：
        // 关闭 contextIsolation 以便 preload 在主世界安装 WebSocket shim；
        // 仍保持 sandbox + 无 nodeIntegration，页面拿不到 ipcRenderer。
        contextIsolation: false,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    mainWindow = win

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => { mainWindow = null })

    // 外链与导航治理：一律不接管页面导航；新窗口请求交给系统浏览器。
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (TRANSPORT === 'ipc' && !url.startsWith(appUrl())) {
        event.preventDefault()
        if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
      }
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] gone:', details.reason)
      if (details.reason !== 'clean-exit' && mainWindow !== null) {
        void dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: '界面崩溃',
          message: '渲染进程异常退出，正在重新加载…',
        }).then(() => {
          if (mainWindow !== null) mainWindow.webContents.reload()
        })
      }
    })
  }

  const loadApp = (port: number): void => {
    if (mainWindow === null) return
    if (TRANSPORT === 'http') {
      void mainWindow.loadURL(`http://127.0.0.1:${port}/`)
    } else {
      void mainWindow.loadURL(appUrl())
    }
  }

  const showLoading = (win: BrowserWindow): void => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        background:#0f1420;color:#c9d4e8;font:14px/1.6 -apple-system,sans-serif}
      .box{text-align:center}.spin{width:28px;height:28px;margin:0 auto 14px;border:3px solid #2a3a5c;
        border-top-color:#4a90ff;border-radius:50%;animation:r 0.9s linear infinite}
      @keyframes r{to{transform:rotate(360deg)}}
    </style></head><body><div class="box"><div class="spin"></div>正在启动 DSH 宿主…</div></body></html>`
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  /** 启动失败内联页：显示原因，提供"重试 / 退出"。 */
  const showFailure = (win: BrowserWindow, message: string, detail: string): void => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1420;color:#c9d4e8;font:14px/1.6 -apple-system,sans-serif}
      .box{max-width:600px;padding:24px}.title{font-size:16px;font-weight:600;color:#ff8a8a;margin-bottom:10px}
      .msg{color:#e8eef8;word-break:break-all;margin-bottom:8px}.detail{color:#8fa3c0;font-size:12px;white-space:pre-wrap;margin-bottom:20px}
      button{background:#2a3a5c;color:#eaf1ff;border:0;border-radius:8px;padding:8px 18px;font-size:13px;cursor:pointer;margin-right:8px}
      button:hover{background:#34486e}button.primary{background:#4a90ff}button:disabled{opacity:.5}
    </style></head><body><div class="box">
      <div class="title">DSH 宿主启动失败</div>
      <div class="msg" id="msg"></div>
      <div class="detail" id="detail"></div>
      <button class="primary" id="retry">重试</button><button id="quit">退出</button>
    </div><script>
      document.getElementById('msg').textContent = ${JSON.stringify(message)};
      document.getElementById('detail').textContent = ${JSON.stringify(detail)};
      const retry = document.getElementById('retry');
      retry.addEventListener('click', async () => {
        retry.disabled = true; retry.textContent = '重启中…';
        try {
          const r = await window.__dshRetryHost();
          if (r && r.port) {
            if (location.protocol === 'dsh-app:') location.href = 'dsh-app://localhost/';
            else location.href = 'http://127.0.0.1:' + r.port + '/';
          } else {
            document.getElementById('detail').textContent = '重启失败：' + ((r && r.error) || '未知错误');
            retry.disabled = false; retry.textContent = '重试';
          }
        } catch (e) {
          document.getElementById('detail').textContent = '重启失败：' + String(e);
          retry.disabled = false; retry.textContent = '重试';
        }
      });
      document.getElementById('quit').addEventListener('click', () => window.__dshQuit());
    </script></body></html>`
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  /** 记录并展示启动失败页（窗口被关闭后重建时复用同一信息）。 */
  const failStartup = (win: BrowserWindow, message: string, detail: string): void => {
    startupFailure = { message, detail }
    showFailure(win, message, detail)
  }

  /**
   * 确保应用窗口存在且已加载应用页。
   * - 已有窗口：还原最小化并聚焦（Dock 点击 / 二次启动的标准行为）；
   * - 无窗口（用户点了窗口关闭钮之后）：重建窗口并接回仍在运行的宿主。
   *   宿主已就绪直接用其端口加载应用页；未就绪则走完整启动流程；
   *   启动早期失败则复用失败信息。
   */
  const ensureWindow = (): void => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      return
    }
    createWindow()
    const win = mainWindow
    if (win === null) return

    if (host === undefined) {
      const f = startupFailure
      failStartup(win, f?.message ?? 'DSH 宿主未初始化', f?.detail ?? '应用未完成启动，请退出后重新打开。')
      return
    }
    const port = host.currentPort
    if (port !== undefined) {
      // 宿主仍存活：直接加载应用页（窗口隐藏期间完成渲染，无闪烁）。
      loadApp(port)
    } else {
      showLoading(win) // 宿主未就绪或已退出：走完整启动流程
      void host.waitReady()
        .then((p) => loadApp(p))
        .catch((error) => {
          console.error('[desktop] host failed to start:', error)
          if (mainWindow !== null) {
            failStartup(mainWindow, String(error), `DSH 检出目录：${CHECKOUT}（可用 DSH_CHECKOUT 覆盖）`)
          }
        })
    }
  }

  const onHostCrashed = async (hm: HostManager, code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
    if (mainWindow === null) return
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DSH 宿主已退出',
      message: `宿主进程意外退出（code=${String(code)} signal=${String(signal)}）`,
      detail: '可以选择重启宿主，或退出应用。',
      buttons: ['重启宿主', '退出'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      try {
        const port = await hm.waitReady()
        loadApp(port)
      } catch (error) {
        console.error('[host] restart failed:', error)
      }
    } else {
      app.quit()
    }
  }

  void app.whenReady().then(async () => {
    console.log(`[desktop] transport=${TRANSPORT} node=${process.versions.node} electron=${process.versions.electron}`)

    // Finder 双击启动时 PATH 无 node：运行时解析绝对路径（DSH_NODE → PATH → nvm → homebrew）
    const nodeBin = resolveNodeBinary()
    if (nodeBin === undefined) {
      createWindow()
      if (mainWindow !== null) {
        failStartup(
          mainWindow,
          '未找到可用的 Node.js 运行时',
          'DSH 宿主需要 Node.js ^22.19 或 >=24。\n'
          + '请安装 Node.js 后用 DSH_NODE=/绝对/路径/node 指定，然后点"重试"。',
        )
      }
      return
    }

    // 宿主入口：bundle 模式用自包含 node_modules 里的 CLI；checkout 模式跑源码（tsx）
    const hostEntry = HOST_SOURCE === 'bundle'
      ? join(BUNDLE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : join(CHECKOUT, 'apps', 'cli', 'src', 'bin.ts')
    const hostCwd = HOST_SOURCE === 'bundle' ? BUNDLE_DIR : CHECKOUT
    const hostEntryIsSource = HOST_SOURCE === 'checkout'
    if (HOST_SOURCE === 'bundle' && !existsSync(hostEntry)) {
      createWindow()
      if (mainWindow !== null) {
        failStartup(
          mainWindow,
          'App 内未找到 DSH host 包',
          `缺少 ${hostEntry}\n请重新打包（npm run bundle:host 后 electron-builder 重新构建）。`,
        )
      }
      return
    }

    const hostManager = new HostManager({
      entry: hostEntry,
      entryIsSource: hostEntryIsSource,
      cwd: hostCwd,
      dshHome: DSH_HOME,
      logDir: LOG_DIR,
      nodeBin,
    })
    host = hostManager
    hostManager.on('exit', (code, signal) => { void onHostCrashed(hostManager, code, signal) })

    const updater = setupUpdater()
    registerIpc({
      getPort: () => hostManager.currentPort,
      getWindow,
      restartHost: () => hostManager.restart(),
      quitApp: () => app.quit(),
      appVersion: app.getVersion(),
    })
    registerProtocol(() => hostManager.currentPort)

    buildMenu({
      getWindow,
      dshHome: DSH_HOME,
      checkout: CHECKOUT,
      logDir: LOG_DIR,
      hostSource: HOST_SOURCE,
      onCheckUpdates: () => { void updater.checkForUpdates() },
      onRestartHost: () => {
        void hostManager.restart().then((port) => loadApp(port))
      },
      onOpenHostInBrowser: () => {
        const port = hostManager.currentPort
        if (port !== undefined) void shell.openExternal(`http://127.0.0.1:${port}/`)
      },
    })

    createWindow()
    if (mainWindow !== null) showLoading(mainWindow)

    try {
      const port = await host.waitReady()
      loadApp(port)
    } catch (error) {
      console.error('[desktop] host failed to start:', error)
      if (mainWindow !== null) {
        failStartup(
          mainWindow,
          String(error),
          `DSH 检出目录：${CHECKOUT}（可用 DSH_CHECKOUT 覆盖）\nNode：${nodeBin}（可用 DSH_NODE 覆盖）`,
        )
      }
    }
  })

  app.on('activate', () => {
    ensureWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void (async () => {
      try { await host?.stop() } catch { /* 尽力而为 */ }
      host?.close()
      app.exit(0)
    })()
  })
}
