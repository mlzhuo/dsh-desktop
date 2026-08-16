/**
 * The sidebar pet: a compact, playful live summary of today's usage. The
 * whale mark bobs gently, a pulse dot shows the feed is live, and the copy
 * line renders input/output tokens, the account balance of the API key's
 * host account, code lines and commits for the current local day. Clicking
 * anywhere on the pet opens the full stats page (StatsPage). Data polls the
 * host `stats.daily`/`stats.balance` on a fixed cadence and on window focus;
 * failures degrade to a quiet dash rather than an error state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCompact, formatLines, formatRmb } from './format.ts'
import type { StatsApiFace, StatsBalanceValue, StatsDailyValue } from './wire.ts'
import type { SidebarKey } from '../locales.ts'
import css from './StatsPet.module.css'

/** How often the pet refreshes today's snapshot (ms). */
const PET_POLL_MS = 30_000
/** How long a failed poll keeps the previous data before going quiet (ms). */
const PET_STALE_MS = 5 * 60_000

export interface StatsPetProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
  /** The host stats api face (injected by the sidebar plugin). */
  api: StatsApiFace
  /** Opens the full stats page. */
  onOpen: () => void
  /** Namespace-bound translate for the pet copy. */
  t: (key: SidebarKey, params?: Record<string, unknown>) => string
}

/** Today's row, or undefined while nothing has loaded yet. */
function todayOf(value: StatsDailyValue | undefined): StatsDailyValue['days'][number] | undefined {
  return value?.days[value.days.length - 1]
}

export function StatsPet({ wide, api, onOpen, t }: StatsPetProps) {
  const [snapshot, setSnapshot] = useState<StatsDailyValue | undefined>(undefined)
  const [balance, setBalance] = useState<StatsBalanceValue | undefined>(undefined)
  const [failedAt, setFailedAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const { result } = await api.daily({ days: 1 }, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) {
        setSnapshot(result.value)
        setFailedAt(null)
      } else {
        setFailedAt(Date.now())
      }
    } catch {
      if (!controller.signal.aborted) setFailedAt(Date.now())
    }
    // Balance is independent and non-fatal: an unavailable balance query
    // (older host, missing credential, provider fault) degrades the balance
    // line to a dash without dimming the pet.
    try {
      const balanceResult = await api.balance({}, controller.signal)
      if (controller.signal.aborted) return
      if (balanceResult.result.ok) setBalance(balanceResult.result.value)
    } catch {
      // Balance stays at its previous value; the pet remains live.
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, PET_POLL_MS)
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      abortRef.current?.abort()
    }
  }, [refresh])

  const today = todayOf(snapshot)
  const stale = failedAt !== null && snapshot !== undefined && Date.now() - failedAt > PET_STALE_MS
  const live = snapshot !== undefined && !stale

  // Rail: a plain pet medallion, the whole button opens the page.
  if (!wide) {
    return (
      <button
        type="button"
        className={clsx(css.railPet, !live && css.dimmed)}
        aria-label={t('stats.pet.open')}
        onClick={onOpen}
      >
        <span className={css.railAvatar}>
          <FishLogo size={20} />
          <span className={clsx(css.liveDot, !live && css.liveDotOff)} />
        </span>
      </button>
    )
  }

  const input = today?.tokens.input ?? null
  const output = today?.tokens.output ?? null
  const balanceTotal = balance?.total ?? null
  const commits = today?.code.commits ?? null
  const added = today?.code.linesAdded ?? null
  const deleted = today?.code.linesDeleted ?? null

  const tokenLine = input === null || output === null
    ? t('stats.dash')
    : t('stats.pet.tokens', {
      input: formatCompact(input),
      output: formatCompact(output),
    })
  const balanceLine = balanceTotal === null
    ? t('stats.dash')
    : t('stats.pet.balance', { balance: formatRmb(balanceTotal) })
  const codeLine = commits === null || added === null || deleted === null
    ? t('stats.dash')
    : t('stats.pet.code', {
      lines: formatLines(added, deleted),
      commits: String(commits),
    })

  return (
    <button
      type="button"
      className={clsx(css.pet, !live && css.dimmed)}
      aria-label={t('stats.pet.open.detail')}
      onClick={onOpen}
    >
      <span className={css.avatar}>
        <FishLogo className={css.fish} size={24} />
        <span className={clsx(css.liveDot, !live && css.liveDotOff)} />
      </span>
      <span className={css.copy}>
        <span className={css.title}>{t('stats.title')}</span>
        <span className={css.metric}>{tokenLine}</span>
        <span className={css.metric}>{balanceLine}</span>
        <span className={clsx(css.metric, css.codeMetric)}>{codeLine}</span>
      </span>
    </button>
  )
}
