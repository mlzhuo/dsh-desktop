/**
 * DSH host 子进程管理器。
 *
 * 以子进程方式运行 DSH 宿主（与命令行 `dsh web` 完全相同的运行时），
 * 用 `--port 0` 让 OS 分配空闲端口，并从 stdout 就绪行解析实际端口：
 *
 *   dsh web: http://127.0.0.1:PORT
 *
 * 进程隔离的好处：宿主崩溃可独立重启；宿主所需 Node 版本不受 Electron
 * 内置 Node 约束（默认使用系统 node，可用 DSH_NODE 覆盖）；宿主日志独立落盘。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface HostOptions {
  /** 宿主入口：checkout 模式为 <checkout>/apps/cli/src/bin.ts；bundle 模式为 <host>/node_modules/@deepseek-ai/dsh/lib/bin.js */
  entry: string
  /** 入口是否为 TS 源码（需要 `--import tsx/esm` 前缀）。 */
  entryIsSource: boolean
  /** spawn 工作目录。 */
  cwd: string
  /** Node 可执行文件，默认 'node'（PATH 解析）。 */
  nodeBin?: string
  /** DSH_HOME，默认 ~/.dsh。 */
  dshHome?: string
  /** 日志目录，默认 Electron logs 目录。 */
  logDir?: string
  /** 等待就绪行的超时（毫秒）。 */
  readyTimeoutMs?: number
}

export interface HostEvents {
  exit: (code: number | null, signal: NodeJS.Signals | null) => void
}

/** stdout 就绪行：`dsh web: http://127.0.0.1:PORT`。 */
const READY_LINE = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/

export class HostManager extends EventEmitter {
  private child: ChildProcess | null = null
  private port: number | undefined
  private readyPromise: Promise<number> | null = null
  private logStream: WriteStream | null = null
  private stopped = false
  private readonly opts: Required<Pick<HostOptions, 'entry' | 'entryIsSource' | 'cwd' | 'nodeBin' | 'dshHome' | 'readyTimeoutMs'>> & Pick<HostOptions, 'logDir'>

  constructor(options: HostOptions) {
    super()
    this.opts = {
      entry: resolve(options.entry),
      entryIsSource: options.entryIsSource,
      cwd: resolve(options.cwd),
      nodeBin: options.nodeBin ?? 'node',
      dshHome: options.dshHome ?? join(homedir(), '.dsh'),
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      logDir: options.logDir,
    }
  }

  /** 当前端口（未就绪时为 undefined）。 */
  get currentPort(): number | undefined {
    return this.port
  }

  /** 等待宿主就绪，返回实际端口。 */
  waitReady(): Promise<number> {
    if (this.readyPromise === null) this.start()
    return this.readyPromise!
  }

  /** 启动（或重启）宿主进程。幂等：已在运行时直接返回当前端口。 */
  start(): Promise<number> {
    if (this.child !== null) return this.readyPromise!
    this.stopped = false
    this.port = undefined
    this.readyPromise = new Promise<number>((resolveReady, rejectReady) => {
      const args = [
        ...(this.opts.entryIsSource ? ['--import', 'tsx/esm'] : []),
        this.opts.entry,
        '--profile', 'web', '--port', '0',
      ]
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DSH_HOME: this.opts.dshHome,
      }
      this.log(`spawn: ${this.opts.nodeBin} ${args.join(' ')}  (cwd=${this.opts.cwd})`)
      const child = spawn(this.opts.nodeBin, args, {
        cwd: this.opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.log('ready-timeout: host did not print the URL line in time')
        rejectReady(new Error(`dsh host did not become ready within ${this.opts.readyTimeoutMs}ms`))
      }, this.opts.readyTimeoutMs)

      const onStdout = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        this.logStream?.write(text)
        if (settled) return
        const match = READY_LINE.exec(text)
        if (match !== null) {
          settled = true
          clearTimeout(timer)
          this.port = Number(match[1])
          this.log(`host ready at http://127.0.0.1:${this.port}`)
          resolveReady(this.port)
        }
      }
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', (chunk: Buffer) => {
        this.logStream?.write(`[stderr] ${chunk.toString('utf8')}`)
      })
      child.on('error', (error) => {
        this.log(`spawn error: ${String(error)}`)
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectReady(error)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (settled && !this.stopped) {
          this.log(`host exited unexpectedly: code=${code} signal=${String(signal)}`)
          this.emit('exit', code, signal)
        }
        this.child = null
        this.readyPromise = null
        this.port = undefined
        if (!settled) {
          settled = true
          this.log(`host exited before ready: code=${code} signal=${String(signal)}`)
          rejectReady(new Error(`dsh host exited before ready (code=${code})`))
        }
      })
    })
    return this.readyPromise
  }

  /** 优雅停机：SIGTERM，超时后 SIGKILL。 */
  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (child === null) return
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit())
    })
    child.kill('SIGTERM')
    const killer = setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL')
    }, 5_000)
    await exited
    clearTimeout(killer)
    this.child = null
    this.readyPromise = null
    this.port = undefined
    this.log('host stopped')
  }

  /** 重启宿主（崩溃恢复 / 菜单手动重启）。 */
  async restart(): Promise<number> {
    await this.stop()
    return this.waitReady()
  }

  /** 释放日志流。 */
  close(): void {
    this.logStream?.end()
    this.logStream = null
  }

  private log(line: string): void {
    console.log(`[host] ${line}`) // 开发可见性：宿主日志同时镜像到应用 stdout
    if (this.logStream === null) {
      const dir = this.opts.logDir
      if (dir !== undefined) {
        try {
          mkdirSync(dir, { recursive: true })
          this.logStream = createWriteStream(join(dir, 'dsh-host.log'), { flags: 'a' })
          this.logStream.on('error', (error) => console.error('[host] log stream error:', error))
        } catch (error) {
          console.error('[host] failed to open log stream:', error)
          this.logStream = null
        }
      } else {
        this.logStream = null
      }
    }
    this.logStream?.write(`[${new Date().toISOString()}] ${line}\n`)
  }
}
