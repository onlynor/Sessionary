import type { SessionSummary, UsageEntry } from './model.ts'

/** one session's tokens on one day (local time) with one model */
export interface UsageDay {
  /** YYYY-MM-DD, in this computer's time zone */
  day: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** model calls (or, for an agent that keeps only a session total, 1) */
  requests: number
  /** in USD, when the agent recorded it; undefined = not recorded (not zero) */
  cost?: number
}

/**
 * A row of the Usage page: tokens on one day for one model, from one session (the agents' own history) or through one
 * route (the gateway, `sessionId` empty). Both sources answer with these, so the page draws them the same way.
 */
export interface UsageDayRow extends UsageDay {
  agent: string
  sessionId?: string
  /** the gateway's route (a model or `group/<id>`) */
  route?: string
  /** gateway requests that failed */
  failed?: number
}

export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * A session's usage by day: each call on the day it was made, so a session that runs past midnight counts on both
 * days. An agent that keeps only a session total puts it on the day the session was last active (the best there is).
 */
export function usageByDay(s: Pick<SessionSummary, 'updatedAt' | 'model' | 'tokens' | 'cost'>, entries: UsageEntry[] | undefined): UsageDay[] {
  const by = new Map<string, UsageDay>()
  for (const e of entries ?? []) {
    if (!(e.input || e.output || e.cacheRead || e.cacheWrite) || !Number.isFinite(e.time)) continue
    const day = dayKey(e.time), model = e.model || s.model || ''
    const k = `${day}\u0000${model}`
    const r = by.get(k) ?? by.set(k, { day, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }).get(k)!
    r.input += e.input; r.output += e.output; r.cacheRead += e.cacheRead; r.cacheWrite += e.cacheWrite; r.requests++
    if (e.cost != null) r.cost = (r.cost ?? 0) + e.cost
  }
  if (by.size || !s.tokens || !(s.tokens.input || s.tokens.output)) return [...by.values()]
  return [{ day: dayKey(s.updatedAt), model: s.model ?? '', input: s.tokens.input, output: s.tokens.output, cacheRead: 0, cacheWrite: 0, requests: 1, ...(s.cost != null && { cost: s.cost }) }]
}

/** a session's totals from its entries: input here is everything read (fresh and cached), as the lists show it */
export function totalsOf(entries: UsageEntry[]): { tokens?: { input: number; output: number }; cost?: number } {
  if (!entries.length) return {}
  let input = 0, output = 0, cost = 0, priced = false
  for (const e of entries) { input += e.input + e.cacheRead + e.cacheWrite; output += e.output; if (e.cost != null) { cost += e.cost; priced = true } }
  return { tokens: { input, output }, ...(priced && { cost }) }
}
