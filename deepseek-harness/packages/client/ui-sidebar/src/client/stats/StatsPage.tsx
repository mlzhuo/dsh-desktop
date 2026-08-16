/**
 * The full stats page: a fixed full-viewport layer opened by the sidebar pet.
 * Renders the trailing daily window (7/14/30 switchable) as SVG charts —
 * token usage (stacked), account balance, code lines (diverging), commits —
 * plus a per-day commit records list and the scanned repositories. The host
 * does every computation; this page only formats and draws. Charts are pure
 * SVG (no chart dependency), themed with the design tokens, with native
 * `<title>` tooltips on every bar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formatCompact, formatDateRange, formatDayLabel, formatRmb,
} from './format.ts'
import type { StatsApiFace, StatsBalanceValue, StatsDay, StatsDailyValue } from './wire.ts'
import type { SidebarKey } from '../locales.ts'
import css from './StatsPage.module.css'

/** Window choices offered by the page switcher. */
const WINDOWS = [7, 14, 30] as const

/** Page refresh cadence (ms). */
const PAGE_POLL_MS = 60_000

/** Namespace-bound translate (same seat SidebarRoot receives). */
type Translate = (key: SidebarKey, params?: Record<string, unknown>) => string

/** SVG geometry. */
const VIEW_W = 680
const VIEW_H = 230
const MARGIN = { top: 14, right: 14, bottom: 30, left: 56 }
const PLOT_W = VIEW_W - MARGIN.left - MARGIN.right
const PLOT_H = VIEW_H - MARGIN.top - MARGIN.bottom

/** Round up to a "nice" axis ceiling: 1/2/5 × 10^k. */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = 10 ** exp
  const scaled = value / base
  const ceil = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return ceil * base
}

/** Y position for a value within the plot. */
function yFor(value: number, max: number): number {
  return MARGIN.top + PLOT_H - (value / max) * PLOT_H
}

/** Axis gridlines + tick labels (0 / 25 / 50 / 75 / 100% of the ceiling). */
function Axis({ max }: { max: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <g>
      {ticks.map((tick) => {
        const y = yFor(max * tick, max)
        return (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={VIEW_W - MARGIN.right}
              y1={y}
              y2={y}
              stroke="var(--dsw-alias-border-l2)"
              strokeWidth={1}
              strokeDasharray={tick === 0 ? undefined : '3 4'}
            />
            <text
              x={MARGIN.left - 8}
              y={y + 3}
              textAnchor="end"
              className={css.axisLabel}
            >
              {formatCompact(max * tick)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** Per-day x labels under the plot; skips every other label when crowded. */
function DayLabels({ days, now }: { days: readonly StatsDay[]; now: Date }) {
  const step = days.length > 15 ? 2 : 1
  return (
    <g>
      {days.map((day, index) => {
        if (index % step !== 0) return null
        const slot = PLOT_W / days.length
        const x = MARGIN.left + slot * index + slot / 2
        const label = index === days.length - 1
          ? formatDayLabel(day.date, now)
          : day.date.slice(5)
        return (
          <text
            key={day.date}
            x={x}
            y={VIEW_H - 8}
            textAnchor="middle"
            className={css.dayLabel}
          >
            {label}
          </text>
        )
      })}
    </g>
  )
}

/** Stacked bar chart: input / cache-read / cache-write / output per day. */
function TokensChart({ days, now, t }: { days: readonly StatsDay[]; now: Date; t: Translate }) {
  const max = niceCeil(Math.max(1, ...days.map(day => day.tokens.input + day.tokens.output + day.tokens.cacheRead + day.tokens.cacheWrite)))
  const slot = PLOT_W / days.length
  const barW = Math.max(4, slot * 0.58)
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className={css.chart} role="img" aria-label={t('stats.chart.tokens.title')}>
      <Axis max={max} />
      {days.map((day, index) => {
        const x = MARGIN.left + slot * index + (slot - barW) / 2
        const { input, output, cacheRead, cacheWrite } = day.tokens
        const total = input + output + cacheRead + cacheWrite
        const yInput = yFor(total, max)
        const yOutput = yFor(total - output, max)
        const yCacheWrite = yFor(total - output - cacheWrite, max)
        const yCacheRead = yFor(total - output - cacheWrite - cacheRead, max)
        const label = t('stats.tooltip.tokens', {
          date: day.date,
          input: formatCompact(input),
          cacheRead: formatCompact(cacheRead),
          cacheWrite: formatCompact(cacheWrite),
          output: formatCompact(output),
          total: formatCompact(total),
        })
        return (
          <g key={day.date}>
            <title>{label}</title>
            {total > 0 && (
              <>
                <rect x={x} y={yInput} width={barW} height={MARGIN.top + PLOT_H - yInput} className={css.barInput} />
                <rect x={x} y={yOutput} width={barW} height={Math.max(0, yInput - yOutput)} className={css.barOutput} />
                <rect x={x} y={yCacheWrite} width={barW} height={Math.max(0, yOutput - yCacheWrite)} className={css.barCacheWrite} />
                <rect x={x} y={yCacheRead} width={barW} height={Math.max(0, yCacheWrite - yCacheRead)} className={css.barCacheRead} />
              </>
            )}
          </g>
        )
      })}
      <DayLabels days={days} now={now} />
    </svg>
  )
}

/** Diverging bar chart: added lines up, deleted lines down. */
function CodeChart({ days, now, t }: { days: readonly StatsDay[]; now: Date; t: Translate }) {
  const mid = MARGIN.top + PLOT_H / 2
  const half = PLOT_H / 2
  const max = niceCeil(Math.max(1, ...days.map(day => Math.max(day.code.linesAdded, day.code.linesDeleted))))
  const slot = PLOT_W / days.length
  const barW = Math.max(4, slot * 0.5)
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className={css.chart} role="img" aria-label={t('stats.chart.code.title')}>
      <line x1={MARGIN.left} x2={VIEW_W - MARGIN.right} y1={mid} y2={mid} stroke="var(--dsw-alias-border-l3)" strokeWidth={1} />
      {[0.5, 1].map((tick) => {
        const y = mid - half * tick
        return (
          <g key={tick}>
            <line x1={MARGIN.left} x2={VIEW_W - MARGIN.right} y1={y} y2={y} stroke="var(--dsw-alias-border-l2)" strokeWidth={1} strokeDasharray="3 4" />
            <text x={MARGIN.left - 8} y={y + 3} textAnchor="end" className={css.axisLabel}>{formatCompact(max * tick)}</text>
          </g>
        )
      })}
      {days.map((day, index) => {
        const x = MARGIN.left + slot * index + (slot - barW) / 2
        const addedH = (day.code.linesAdded / max) * half
        const deletedH = (day.code.linesDeleted / max) * half
        return (
          <g key={day.date}>
            <title>{t('stats.tooltip.code', {
              date: day.date,
              added: formatCompact(day.code.linesAdded),
              deleted: formatCompact(day.code.linesDeleted),
            })}</title>
            {day.code.linesAdded > 0 && (
              <rect x={x} y={mid - addedH} width={barW} height={addedH} className={css.barAdded} />
            )}
            {day.code.linesDeleted > 0 && (
              <rect x={x} y={mid} width={barW} height={deletedH} className={css.barDeleted} />
            )}
          </g>
        )
      })}
      <DayLabels days={days} now={now} />
    </svg>
  )
}

/** Single-series bar chart for commit counts (with the count above each bar). */
function CommitsChart({ days, now, t }: { days: readonly StatsDay[]; now: Date; t: Translate }) {
  const max = niceCeil(Math.max(1, ...days.map(day => day.code.commits)))
  const slot = PLOT_W / days.length
  const barW = Math.max(4, slot * 0.4)
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className={css.chart} role="img" aria-label={t('stats.chart.commits.title')}>
      <Axis max={max} />
      {days.map((day, index) => {
        const x = MARGIN.left + slot * index + (slot - barW) / 2
        const y = yFor(day.code.commits, max)
        return (
          <g key={day.date}>
            <title>{t('stats.tooltip.commits', { date: day.date, commits: String(day.code.commits) })}</title>
            {day.code.commits > 0 && (
              <>
                <rect x={x} y={y} width={barW} height={MARGIN.top + PLOT_H - y} className={css.barCommits} rx={2} />
                <text
                  x={x + barW / 2}
                  y={y - 5}
                  textAnchor="middle"
                  className={css.barLabel}
                >
                  {day.code.commits}
                </text>
              </>
            )}
          </g>
        )
      })}
      <DayLabels days={days} now={now} />
    </svg>
  )
}

/** One summary stat card (today's figure). */
function StatCard(props: { label: string; value: React.ReactNode; sub?: string | undefined; tone: 'tokens' | 'cost' | 'code' | 'commits' }) {
  return (
    <div className={clsx(css.statCard, css[`tone-${props.tone}`])}>
      <span className={css.statLabel}>{props.label}</span>
      <span className={css.statValue}>{props.value}</span>
      {props.sub !== undefined && <span className={css.statSub}>{props.sub}</span>}
    </div>
  )
}

/** A legend chip: colored dot + label. */
function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className={css.legend}>
      {items.map(item => (
        <span key={item.label} className={css.legendItem}>
          <span className={css.legendDot} style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

/** Chart card shell: title, optional hint/legend, children. */
function ChartCard(props: { title: string; hint?: string; legend?: Array<{ color: string; label: string }>; children: React.ReactNode }) {
  return (
    <section className={css.chartCard}>
      <div className={css.chartHeader}>
        <h3 className={css.chartTitle}>{props.title}</h3>
        {props.hint !== undefined && <span className={css.chartHint}>{props.hint}</span>}
        {props.legend !== undefined && <Legend items={props.legend} />}
      </div>
      {props.children}
    </section>
  )
}

export interface StatsPageProps {
  /** The host stats api face (injected by the sidebar plugin). */
  api: StatsApiFace
  /** Closes the page. */
  onClose: () => void
  /** Namespace-bound translate for the page copy. */
  t: Translate
}

export function StatsPage({ api, onClose, t }: StatsPageProps) {
  const [windowDays, setWindowDays] = useState<number>(14)
  const [snapshot, setSnapshot] = useState<StatsDailyValue | undefined>(undefined)
  const [balance, setBalance] = useState<StatsBalanceValue | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const { result } = await api.daily({ days: windowDays }, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) {
        setSnapshot(result.value)
        setError(false)
      } else {
        setError(true)
      }
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
    // Balance is non-fatal: unavailable (older host / missing credential /
    // provider fault) degrades the balance card to a dash.
    try {
      const balanceResult = await api.balance({}, controller.signal)
      if (controller.signal.aborted) return
      if (balanceResult.result.ok) setBalance(balanceResult.result.value)
    } catch {
      // Balance stays at its previous value.
    }
  }, [api, windowDays])

  useEffect(() => {
    setLoading(true)
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, PAGE_POLL_MS)
    return () => {
      window.clearInterval(timer)
      abortRef.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const days = snapshot?.days ?? []
  const today = days.length > 0 ? days[days.length - 1] as StatsDay : undefined
  const totalCommits = days.reduce((sum, day) => sum + day.code.commits, 0)
  const now = new Date()

  return (
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('stats.page.title')}>
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.page}>
        <header className={css.header}>
          <div className={css.heading}>
            <h2 className={css.title}>{t('stats.page.title')}</h2>
            <span className={css.subtitle}>
              {snapshot === undefined ? '…' : `${formatDateRange(days)} · ${snapshot.timeZone}`}
            </span>
          </div>
          <div className={css.headerActions}>
            <div className={css.windowSwitch} role="group" aria-label={t('stats.window', { days: String(windowDays) })}>
              {WINDOWS.map((daysCount) => (
                <button
                  key={daysCount}
                  type="button"
                  className={clsx(css.windowButton, daysCount === windowDays && css.windowActive)}
                  onClick={() => { setWindowDays(daysCount) }}
                >
                  {t('stats.window', { days: String(daysCount) })}
                </button>
              ))}
            </div>
            <button type="button" className={css.iconButton} aria-label={t('stats.refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutline16 size={16} className={clsx(loading && css.spinning)} />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('stats.close')} onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </header>

        <div className={css.body}>
          {error && snapshot === undefined && (
            <div className={css.state}>{t('stats.unavailable')}</div>
          )}
          {!error && snapshot === undefined && (
            <div className={css.state}>{loading ? t('stats.loading') : t('stats.empty')}</div>
          )}

          {snapshot !== undefined && (
            <>
              <div className={css.summary}>
                <StatCard
                  label={t('stats.today.input')}
                  value={formatCompact(today?.tokens.input ?? 0)}
                  sub={today === undefined ? undefined : t('stats.cache.read', { value: formatCompact(today.tokens.cacheRead) })}
                  tone="tokens"
                />
                <StatCard
                  label={t('stats.today.output')}
                  value={formatCompact(today?.tokens.output ?? 0)}
                  tone="tokens"
                />
                <StatCard
                  label={t('stats.balance.total')}
                  value={balance === undefined ? t('stats.dash') : formatRmb(balance.total)}
                  sub={balance === undefined ? undefined : t('stats.balance.account', { currency: balance.balances.map(entry => entry.currency).join(' / ') || t('stats.balance.unknown') })}
                  tone="cost"
                />
                <StatCard
                  label={t('stats.today.lines')}
                  value={today === undefined
                    ? '0'
                    : (
                      <>
                        +{formatCompact(today.code.linesAdded)}
                        {' / '}
                        <span className={css.deletedNum}>−{formatCompact(today.code.linesDeleted)}</span>
                      </>
                    )}
                  sub={today === undefined ? undefined : t('stats.lines.net', { value: formatCompact(Math.max(0, today.code.linesAdded - today.code.linesDeleted)) })}
                  tone="code"
                />
                <StatCard
                  label={t('stats.today.commits')}
                  value={String(today?.code.commits ?? 0)}
                  sub={totalCommits > 0 ? t('stats.total.commits', { days: String(windowDays), commits: String(totalCommits) }) : undefined}
                  tone="commits"
                />
              </div>

              <ChartCard
                title={t('stats.chart.tokens.title')}
                hint={t('stats.chart.tokens.hint')}
                legend={[
                  { color: 'var(--dsw-static-purple-500)', label: t('stats.legend.input') },
                  { color: 'var(--dsw-static-purple-300)', label: t('stats.legend.cacheRead') },
                  { color: 'var(--dsw-static-purple-200)', label: t('stats.legend.cacheWrite') },
                  { color: 'var(--dsw-static-purple-450)', label: t('stats.legend.output') },
                ]}
              >
                <TokensChart days={days} now={now} t={t} />
              </ChartCard>

              <div className={css.grid}>
                <ChartCard
                  title={t('stats.chart.code.title')}
                  hint={t('stats.chart.code.hint')}
                  legend={[
                    { color: 'var(--dsw-alias-state-success-primary)', label: t('stats.legend.added') },
                    { color: 'var(--dsw-alias-state-error-primary)', label: t('stats.legend.deleted') },
                  ]}
                >
                  <CodeChart days={days} now={now} t={t} />
                </ChartCard>
                <ChartCard title={t('stats.chart.commits.title')} hint={t('stats.chart.commits.hint')}>
                  <CommitsChart days={days} now={now} t={t} />
                </ChartCard>
              </div>

            </>
          )}
        </div>
      </div>
    </div>
  )
}

