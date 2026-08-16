/**
 * Compact display formatting for the stats surface: token counts, estimated
 * RMB cost, line counts, and day labels. Pure functions, zero dependencies.
 */

/** 1 234 567 → "1.2M"; 12 345 → "12.3k"; 999 → "999". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (value >= 10_000) return `${trim(value / 1_000)}k`
  if (value >= 1_000) return `${trim(value / 1_000)}k`
  return String(Math.round(value))
}

function trim(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/**
 * Estimated RMB cost following the official list prices: ¥0.0003 → "¥0.0003";
 * ¥0.012 → "¥0.012"; ¥1.234 → "¥1.23"; ¥1234 → "¥1.2k". Always at least one
 * significant digit after the decimal.
 */
export function formatRmb(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '¥0'
  if (value >= 1000) return `¥${formatCompact(value)}`
  if (value >= 1) return `¥${value.toFixed(2)}`
  if (value === 0) return '¥0'
  const digits = value < 0.001 ? 4 : value < 0.01 ? 4 : 3
  const fixed = value.toFixed(digits)
  return `¥${fixed.replace(/0+$/, '').replace(/\.$/, '')}`
}

/** Signed line delta: "+1.2k / −300". */
export function formatLines(added: number, deleted: number): string {
  return `+${formatCompact(added)} / −${formatCompact(deleted)}`
}

/** "2026-08-15" → "8-15"; today → "今天", yesterday → "昨天". */
export function formatDayLabel(date: string, now: Date): string {
  const [year, month, day] = date.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return date
  const target = new Date(year, month - 1, day)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((today.getTime() - target.getTime()) / 86_400_000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Full short date used in the page subtitle: "8月1日 – 8月15日". */
export function formatDateRange(days: readonly { date: string }[]): string {
  if (days.length === 0) return ''
  const first = days[0] as { date: string }
  const last = days[days.length - 1] as { date: string }
  const label = (date: string): string => {
    const [, month, day] = date.split('-').map(Number)
    return `${Number(month)}月${Number(day)}日`
  }
  if (first.date === last.date) return label(first.date)
  return `${label(first.date)} – ${label(last.date)}`
}

/** Full commit hash → short form (first 7 chars). */
export function shortHash(hash: string): string {
  return hash.length > 7 ? hash.slice(0, 7) : hash
}

/** Local time label for a commit instant: "14:05". */
export function formatTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
