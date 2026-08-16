/**
 * stats domain contract: cross-session, cross-workspace daily aggregates the
 * Web pet/overview surface reads. The host owns every computation — token
 * usage folds are incremental per session log, the cost column is a
 * provider-price ESTIMATE (labeled on the wire, never a billing figure), and
 * code/commit columns come from `git log` over the registered workspaces'
 * repositories. Method signatures are the source of truth, same as every
 * other domain.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One day's token accounting (all counts are provider-reported tokens). */
export interface StatsDayTokens {
  /** Uncached input tokens. */
  input: number
  /** Completion tokens. */
  output: number
  /** Cache-hit input tokens. */
  cacheRead: number
  /** Cache-write input tokens. */
  cacheWrite: number
}

/** One day's git-derived code activity across the scanned repositories. */
export interface StatsDayCode {
  /** Commits authored on that local day. */
  commits: number
  /** Inserted lines summed over those commits (git `--numstat`). */
  linesAdded: number
  /** Deleted lines summed over those commits (git `--numstat`). */
  linesDeleted: number
}

/** One recent commit row shown under its day. */
export interface StatsCommitSample {
  /** Short repository display name (workspace title, else the path basename). */
  repo: string
  /** Commit subject (first line of the message). */
  message: string
  /** Full commit hash. */
  hash: string
  /** Author instant, epoch milliseconds. */
  at: number
}

/** One calendar day row (host-local dates). */
export interface StatsDay {
  /** `YYYY-MM-DD` in the host's local time zone. */
  date: string
  tokens: StatsDayTokens
  /** Estimated USD cost for the day's tokens (see `costEstimated`). */
  costRmb: number
  code: StatsDayCode
  /** Newest-first commit samples falling on this day (bounded). */
  commits: StatsCommitSample[]
}

/** Response value of `stats.daily`. */
export interface StatsDailyValue {
  /** Wall-clock instant the snapshot was computed, epoch milliseconds. */
  generatedAt: number
  /** Host-local IANA time zone the day buckets were cut in. */
  timeZone: string
  /** Oldest → newest calendar rows, length == requested window (zeros fill gaps). */
  days: StatsDay[]
  /** Git repositories scanned for the code columns. */
  repos: Array<{ title: string; path: string }>
  /**
   * The cost column is an ESTIMATE derived from a static provider-price table
   * keyed by model id (usage records carry no provider billing), never a
   * provider invoice.
   */
  costEstimated: true
}

/** Stats-domain unary methods (the map keys `stats.*` of RpcMethodMap). */
export interface StatsApi {
  /**
   * Computes the daily aggregate snapshot for the trailing window ending
   * today (host-local): token usage and estimated cost from every session log
   * (attached + persisted), plus commit/line activity from git repositories
   * rooted at the registered workspaces. The fold is incremental per session;
   * git scans are cached briefly. `days` clamps to [1, 31], default 14.
   */
  daily(request: RpcRequest<{ days?: number }>, signal?: AbortSignal):
  Promise<RpcResponse<StatsDailyValue>>

  /**
   * Queries the account balance of the API key backing the configured
   * `deepseek-official` provider (the same credential seam and base URL the
   * chat adapter uses), via the official `GET /user/balance` endpoint. The
   * key never leaves the host. Failures (no credentials provider, missing
   * key, transport/HTTP errors) reject with `balance-unavailable`.
   */
  balance(request: RpcRequest<{}>, signal?: AbortSignal):
  Promise<RpcResponse<StatsBalanceValue>>
}

/** One currency's official balance row. */
export interface StatsBalanceEntry {
  /** ISO currency code, e.g. `CNY`. */
  currency: string
  /** Total balance in that currency (granted + topped up). */
  total: number
  /** Balance granted by the platform (promotions). */
  granted: number
  /** Balance topped up by the account owner. */
  toppedUp: number
}

/** Response value of `stats.balance`. */
export interface StatsBalanceValue {
  /** Whether the account is available for API calls. */
  available: boolean
  /** One row per currency reported by the provider. */
  balances: StatsBalanceEntry[]
  /** Sum of `total` across every reported currency. */
  total: number
}
