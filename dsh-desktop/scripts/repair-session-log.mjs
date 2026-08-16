#!/usr/bin/env node
/**
 * 修复 DSH 会话日志的 seq 断裂（committed region 内 seq 不连续）。
 *
 * 按 DSH 存储语义（packages/core/session/src/chunk-rows.ts）：
 *   - 普通记录：事件 seq 存在 `seq` 字段；
 *   - chunk 行（text-chunks / reasoning-chunks / tool-call-chunks）：信封
 *     {type, seq0, time0, data}，展开为 seq0..seq0+len-1 的 assistant/chunk 事件。
 *
 * 修复 = 使每个解码事件的 seq 等于其全局索引：
 *   - chunk 行：seq0 = 全局索引（其成员自动 seq0+k）；
 *   - 普通记录：seq = 全局索引。
 * 事件的类型/时间/内容/顺序一律不改。
 *
 * 同时保持 zstd 帧结构：第 1 帧恰好一行 header；事件全部放入第 2 帧。
 * 用法：node repair-session-log.mjs <session.jsonl.zstd>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const input = process.argv[2]
if (input === undefined || !existsSync(input)) {
  console.error('usage: node repair-session-log.mjs <session.jsonl.zstd>')
  process.exit(1)
}

const CHUNK_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function memberCount(value) {
  if (!CHUNK_TAGS.has(value?.type)) return 1
  const members = value.data?.texts ?? value.data?.args
  if (!Array.isArray(members)) throw new Error(`malformed chunk row: ${JSON.stringify(value).slice(0, 120)}`)
  return members.length
}

// 1. 解压
const raw = execFileSync('zstd', ['-dc', input], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8')
const lines = raw.split('\n')
if (lines[lines.length - 1] === '') lines.pop()
const header = lines[0]
if (!header.includes('"type":"session"')) {
  console.error('unexpected first line (not a session header):', header.slice(0, 120))
  process.exit(1)
}

// 2. 重编号（按解码语义）
let index = 0
let fixed = 0
const out = [header]
for (let i = 1; i < lines.length; i++) {
  const parsed = JSON.parse(lines[i])
  const n = memberCount(parsed)
  if (CHUNK_TAGS.has(parsed?.type)) {
    if (parsed.seq0 !== index) fixed += 1
    parsed.seq0 = index
  } else if (typeof parsed === 'object' && parsed !== null && 'seq' in parsed) {
    if (parsed.seq !== index) fixed += 1
    parsed.seq = index
  }
  out.push(JSON.stringify(parsed))
  index += n
}
console.log(`events: ${index}, seq fixed: ${fixed}`)

// 3. 帧结构重写：frame1 = header 一行；frame2 = 全部事件
const dir = dirname(input)
const headerTxt = join(dir, `.repair-header-${basename(input)}.jsonl`)
const eventsTxt = join(dir, `.repair-events-${basename(input)}.jsonl`)
const headerZst = join(dir, `.repair-header-${basename(input)}.zst`)
const eventsZst = join(dir, `.repair-events-${basename(input)}.zst`)
writeFileSync(headerTxt, header + '\n')
writeFileSync(eventsTxt, out.slice(1).join('\n') + '\n')
execFileSync('zstd', ['-q', '-f', '-3', headerTxt, '-o', headerZst])
execFileSync('zstd', ['-q', '-f', '-3', eventsTxt, '-o', eventsZst])
const combined = Buffer.concat([readFileSync(headerZst), readFileSync(eventsZst)])
writeFileSync(input, combined)
execFileSync('rm', [headerTxt, eventsTxt, headerZst, eventsZst])
console.log(`repaired (frame1=header, frame2=events) -> ${input}`)
