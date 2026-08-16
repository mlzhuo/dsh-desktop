/**
 * stats domain zod schemas (names derived from map keys: statsDailyRequestSchema /
 * statsDailyValueSchema). The wire value stays close to the typed contract —
 * only the exact shapes cross, and the client re-validates the response.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** stats.daily request payload. */
export const statsDailyRequestSchema = z.object({
  days: z.number().int().min(1).max(31).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'stats.daily'>>>

/** One day's token accounting. */
export const statsDayTokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
})

/** One day's git-derived code activity. */
export const statsDayCodeSchema = z.object({
  commits: z.number().int().nonnegative(),
  linesAdded: z.number().int().nonnegative(),
  linesDeleted: z.number().int().nonnegative(),
})

/** One recent commit row. */
export const statsCommitSampleSchema = z.object({
  repo: z.string().min(1),
  message: z.string(),
  hash: z.string().min(1),
  at: z.number().int().nonnegative(),
})

/** One calendar day row. */
export const statsDaySchema = z.object({
  date: z.string(),
  tokens: statsDayTokensSchema,
  costRmb: z.number().nonnegative(),
  code: statsDayCodeSchema,
  commits: z.array(statsCommitSampleSchema),
})

/** stats.balance request payload (empty). */
export const statsBalanceRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'stats.balance'>>>

/** One currency's official balance row. */
export const statsBalanceEntrySchema = z.object({
  currency: z.string(),
  total: z.number().nonnegative(),
  granted: z.number().nonnegative(),
  toppedUp: z.number().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'stats.balance'>['balances'][number]>>

/** stats.balance response value: the account's total balance per the official endpoint. */
export const statsBalanceValueSchema = z.object({
  available: z.boolean(),
  balances: z.array(statsBalanceEntrySchema),
  total: z.number().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'stats.balance'>>>

/** stats.daily response value. */
export const statsDailyValueSchema: z.ZodType<Wire<ResponseValue<'stats.daily'>>> = z.object({
  generatedAt: z.number().int().nonnegative(),
  timeZone: z.string().min(1),
  days: z.array(statsDaySchema),
  repos: z.array(z.object({
    title: z.string().min(1),
    path: z.string().min(1),
  })),
  costEstimated: z.literal(true),
})
