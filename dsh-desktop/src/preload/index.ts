/**
 * Preload（IPC 模式专用）：在主世界安装 WebSocket shim。
 *
 * 页面（dsh-app://app）里的 WebApiClient 用 `new WebSocket(url)` 建立
 * mux/host 事件下行流；protocol.handle 不支持 WebSocket upgrade，因此这里
 * 用 IPC 频道替代真实 socket：
 *   - 订阅：ipcRenderer.send('dsh:events:subscribe', kind)
 *   - 帧：主进程把宿主 WS 帧（解析后的对象）经 'dsh:events:{kind}' 推回，
 *     shim 重新 JSON.stringify 后以 MessageEvent.data 派发（readWebSocket
 *     会对 event.data 做 JSON.parse + schema 校验，形状保持一致）。
 *   - open/close/error 用独立后缀频道复刻真实 WebSocket 语义。
 *
 * 仅当页面协议是 dsh-app: 时生效；HTTP 兜底模式不安装任何 shim。
 */
import { ipcRenderer } from 'electron'

type EventKind = 'mux' | 'host'

function kindOfPath(pathname: string): EventKind | undefined {
  if (pathname.endsWith('/api/events.mux')) return 'mux'
  if (pathname.endsWith('/api/events.host')) return 'host'
  return undefined
}

type Listener = (event: unknown) => void

class DshWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = DshWebSocket.CONNECTING
  readonly OPEN = DshWebSocket.OPEN
  readonly CLOSING = DshWebSocket.CLOSING
  readonly CLOSED = DshWebSocket.CLOSED

  readyState: number = DshWebSocket.CONNECTING
  readonly url: string
  readonly binaryType = 'blob'
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null

  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly kind: EventKind
  private readonly cleanup: () => void

  constructor(url: string | URL) {
    this.url = String(url)
    const parsed = new URL(this.url)
    const kind = kindOfPath(parsed.pathname)
    if (kind === undefined) {
      throw new Error(`dsh-desktop: unsupported WebSocket path "${parsed.pathname}"`)
    }
    this.kind = kind

    const frameChannel = `dsh:events:${kind}`
    const openChannel = `${frameChannel}:open`
    const closeChannel = `${frameChannel}:close`
    const errorChannel = `${frameChannel}:error`

    const onFrame = (_e: unknown, envelope: unknown): void => {
      this.dispatch('message', { data: JSON.stringify(envelope) })
    }
    const onOpen = (): void => {
      this.readyState = DshWebSocket.OPEN
      this.dispatch('open', {})
    }
    const onClose = (): void => {
      if (this.readyState !== DshWebSocket.CLOSED) {
        this.readyState = DshWebSocket.CLOSED
        this.dispatch('close', { code: 1000, reason: '' })
      }
    }
    const onError = (_e: unknown, payload?: { message?: string }): void => {
      this.dispatch('error', { message: payload?.message ?? 'event stream error' })
    }

    ipcRenderer.on(frameChannel, onFrame)
    ipcRenderer.once(openChannel, onOpen)
    ipcRenderer.once(closeChannel, onClose)
    ipcRenderer.on(errorChannel, onError)
    this.cleanup = () => {
      ipcRenderer.removeListener(frameChannel, onFrame)
      ipcRenderer.removeListener(openChannel, onOpen)
      ipcRenderer.removeListener(closeChannel, onClose)
      ipcRenderer.removeListener(errorChannel, onError)
    }

    ipcRenderer.send('dsh:events:subscribe', kind)
  }

  addEventListener(type: string, listener: Listener, _options?: unknown): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: unknown): void {
    const handler = type === 'open' ? this.onopen
      : type === 'message' ? this.onmessage
        : type === 'close' ? this.onclose
          : type === 'error' ? this.onerror
            : null
    try { handler?.call(this, event) } catch (error) { console.error('[dsh-desktop] ws handler threw:', error) }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try { listener.call(this, event) } catch (error) { console.error('[dsh-desktop] ws listener threw:', error) }
    }
  }

  send(_data: unknown): void {
    // 下行专用流：宿主事件流不接收页面消息；静默忽略。
    console.warn('[dsh-desktop] WebSocket.send() ignored: event streams are downlink-only')
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === DshWebSocket.CLOSED) return
    this.readyState = DshWebSocket.CLOSED
    ipcRenderer.send('dsh:events:unsubscribe', this.kind)
    this.cleanup()
    this.dispatch('close', { code: 1000, reason: '' })
  }
}

function installWebSocketShim(): void {
  try {
    // 替换主世界全局：页面后续 `new WebSocket(...)` 都走 IPC 载体。
    (window as unknown as { WebSocket: unknown }).WebSocket = DshWebSocket
    console.log('[dsh-desktop] WebSocket shim installed (ipc transport)')
  } catch (error) {
    console.error('[dsh-desktop] failed to install WebSocket shim:', error)
  }
}

if (typeof window !== 'undefined' && window.location?.protocol === 'dsh-app:') {
  installWebSocketShim()
}

// ---- 通用辅助（所有页面可用，供 loading/错误页与调试使用） ----
const mainWorld = window as unknown as Record<string, unknown>
mainWorld.__dshRetryHost = (): Promise<{ port: number | null; error?: string }> =>
  ipcRenderer.invoke('dsh:host:restart')
mainWorld.__dshQuit = (): void => {
  ipcRenderer.send('dsh:quit')
}
mainWorld.__dshAppInfo = (): Promise<Record<string, unknown>> => ipcRenderer.invoke('dsh:app:info')

export {}
