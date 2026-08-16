/**
 * IPC 桥（主进程侧）：
 *
 * 1. 事件流载体：preload 的 WebSocket shim 经 `dsh:events:subscribe` 订阅，
 *    主进程对宿主回环 `ws://127.0.0.1:PORT/api/events.{mux,host}` 建立真实
 *    WebSocket，把服务端帧（已解析对象）转发回渲染进程；open/close/error
 *    用独立后缀频道通知，让 shim 复刻真实 WebSocket 语义。
 * 2. native seam：目录选择、打开路径/文件/外链（Electron 原生能力）。
 * 3. 应用信息与宿主控制。
 */
import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'

export interface IpcDeps {
  getPort: () => number | undefined
  getWindow: () => BrowserWindow | null
  restartHost: () => Promise<number>
  quitApp: () => void
  appVersion: string
}

type EventKind = 'mux' | 'host'

const EVENT_CHANNEL = (kind: EventKind): string => `dsh:events:${kind}`
const OPEN_CHANNEL = (kind: EventKind): string => `dsh:events:${kind}:open`
const CLOSE_CHANNEL = (kind: EventKind): string => `dsh:events:${kind}:close`
const ERROR_CHANNEL = (kind: EventKind): string => `dsh:events:${kind}:error`

export function registerIpc(deps: IpcDeps): void {
  const sockets = new Map<EventKind, WebSocket>()

  const send = (channel: string, payload?: unknown): void => {
    const win = deps.getWindow()
    if (win !== null && !win.webContents.isDestroyed()) {
      if (payload === undefined) win.webContents.send(channel)
      else win.webContents.send(channel, payload)
    }
  }

  const closeSocket = (kind: EventKind): void => {
    const ws = sockets.get(kind)
    if (ws !== undefined) {
      try { ws.close() } catch { /* already closed */ }
      sockets.delete(kind)
    }
  }

  ipcMain.on('dsh:events:subscribe', (event, kind: unknown) => {
    if (kind !== 'mux' && kind !== 'host') return
    const port = deps.getPort()
    if (port === undefined) {
      send(ERROR_CHANNEL(kind), { message: 'host not ready' })
      return
    }
    // 重复订阅（同一 kind 已连接）直接复用；shim 每次构造都会订阅，
    // 主进程按 kind 去重，避免重复建连。
    if (sockets.has(kind)) return
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.${kind}`)
    sockets.set(kind, ws)
    ws.onopen = () => send(OPEN_CHANNEL(kind))
    ws.onmessage = (ev) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(ev.data))
      } catch {
        return
      }
      send(EVENT_CHANNEL(kind), parsed)
    }
    ws.onerror = () => {
      send(ERROR_CHANNEL(kind), { message: `host ${kind} event stream error` })
    }
    ws.onclose = () => {
      sockets.delete(kind)
      send(CLOSE_CHANNEL(kind))
    }
    event.sender.once('destroyed', () => closeSocket(kind))
  })

  ipcMain.on('dsh:events:unsubscribe', (_event, kind: unknown) => {
    if (kind === 'mux' || kind === 'host') closeSocket(kind)
  })

  // ---- native seam ----

  ipcMain.handle('dsh:native:pickDirectory', async (): Promise<string | null> => {
    const win = deps.getWindow()
    if (win === null) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择目录',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dsh:native:openPath', async (_event, target: unknown): Promise<string> => {
    if (typeof target !== 'string' || target.length === 0) return 'invalid target'
    const error = await shell.openPath(target)
    return error === '' ? 'ok' : error
  })

  ipcMain.handle('dsh:native:reveal', (_event, target: unknown): void => {
    if (typeof target === 'string') shell.showItemInFolder(target)
  })

  ipcMain.handle('dsh:native:openExternal', async (_event, target: unknown): Promise<void> => {
    if (typeof target !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      await shell.openExternal(target)
    }
  })

  // ---- app info / host control ----

  ipcMain.handle('dsh:app:info', (): Record<string, unknown> => ({
    version: deps.appVersion,
    transport: process.env.DSH_TRANSPORT === 'http' ? 'http' : 'ipc',
    port: deps.getPort() ?? null,
  }))

  ipcMain.handle('dsh:host:restart', async (): Promise<{ port: number | null; error?: string }> => {
    try {
      const port = await deps.restartHost()
      return { port }
    } catch (error) {
      return { port: null, error: String(error) }
    }
  })

  ipcMain.on('dsh:quit', () => deps.quitApp())
}
