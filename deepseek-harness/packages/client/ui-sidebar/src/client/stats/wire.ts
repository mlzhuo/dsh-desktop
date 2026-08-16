/**
 * Client-side wire mirror of the host `stats` domain. The host is the single
 * source of truth (packages/host/apiproxy/src/api/stats.ts); this local copy
 * keeps ui-sidebar free of a connection-package dependency — the shape is
 * validated host-side and re-validated by the carrier, so the UI only reads
 * the fields it renders. Every type here is erased at build time.
 */

/** One day's token accounting (provider-reported tokens). */
export interface StatsDayTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One day's git-derived code activity. */
export interface StatsDayCode {
  commits: number
  linesAdded: number
  linesDeleted: number
}

/** One recent commit row. */
export interface StatsCommitSample {
  repo: string
  message: string
  hash: string
  at: number
}

/** One calendar day row (`YYYY-MM-DD`, host-local). */
export interface StatsDay {
  date: string
  tokens: StatsDayTokens
  /** Estimated RMB cost (never a provider bill — see `costEstimated`). */
  costRmb: number
  code: StatsDayCode
  commits: StatsCommitSample[]
}

/** Response value of `stats.daily`. */
export interface StatsDailyValue {
  generatedAt: number
  timeZone: string
  days: StatsDay[]
  repos: Array<{ title: string; path: string }>
  costEstimated: true
}

/** Carrier-level RPC result (the narrow shape the api client returns). */
export type StatsRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** One currency's official balance row. */
export interface StatsBalanceEntry {
  currency: string
  total: number
  granted: number
  toppedUp: number
}

/** Response value of `stats.balance`. */
export interface StatsBalanceValue {
  available: boolean
  balances: StatsBalanceEntry[]
  /** Sum of `total` across every reported currency. */
  total: number
}

/** The only api face the pet/page read: structurally typed `stats.*` methods. */
export interface StatsApiFace {
  daily(
    payload: { days?: number },
    signal?: AbortSignal,
  ): Promise<{ rpcId: string; result: StatsRpcResult<StatsDailyValue> }>
  balance(
    payload: {},
    signal?: AbortSignal,
  ): Promise<{ rpcId: string; result: StatsRpcResult<StatsBalanceValue> }>
}
