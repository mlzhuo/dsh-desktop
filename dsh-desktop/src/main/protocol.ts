/**
 * dsh-app:// 自定义协议：渲染进程的"同源"载体。
 *
 * 页面加载 `dsh-app://app/`（standard + secure + supportFetchAPI），所有
 * 请求（index.html、/assets/*、/plugins/* 客户端 bundle、/api 单发 RPC）
 * 都由主进程代理到回环 host。这样：
 *   - 页面来源是 dsh-app://app，从不直接触碰 127.0.0.1 网络面（纵深防御）；
 *   - 代理转发时剥离 Origin / sec-fetch-* 标记，让请求通过宿主 /api
 *     的 browser-trust 围栏（Host 由 fetch 按目标 URL 自动设为回环权威）。
 *
 * WebSocket 事件流（/api/events.mux、/api/events.host）不走本协议——
 * protocol.handle 不支持 upgrade，由 preload 的 IPC shim 负责（见 ipc.ts）。
 */
import { protocol, net } from 'electron'

const SCHEME = 'dsh-app'
const HOST = 'app'

/** 在 app ready 之前注册特权 scheme（必须）。 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

/** 需要剥离的浏览器标记头：避免 host 的 trust fence 按跨源拒绝。 */
const STRIPPED_HEADERS = new Set([
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'referer',
])

/**
 * 注册 dsh-app 协议处理器。
 * @param getPort - 返回宿主当前端口（未就绪返回 undefined → 503）。
 */
export function registerProtocol(getPort: () => number | undefined): void {
  protocol.handle(SCHEME, async (request) => {
    const port = getPort()
    if (port === undefined) {
      return new Response('dsh host is starting…', { status: 503 })
    }
    const url = new URL(request.url)
    if (url.host !== HOST) {
      return new Response('unknown dsh-app host', { status: 404 })
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const target = `http://127.0.0.1:${port}${path}${url.search}`
    const headers = new Headers(request.headers)
    for (const name of STRIPPED_HEADERS) headers.delete(name)
    const init: RequestInit = { method: request.method, headers }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer()
    }
    try {
      const upstream = await net.fetch(target, init)
      const responseHeaders = new Headers()
      upstream.headers.forEach((value, key) => responseHeaders.set(key, value))
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    } catch (error) {
      console.error('[protocol] upstream fetch failed:', error)
      return new Response('upstream unavailable', { status: 502 })
    }
  })
}

/** 页面 URL（IPC 模式）。 */
export function appUrl(): string {
  return `${SCHEME}://${HOST}/`
}

export { SCHEME as APP_SCHEME }
