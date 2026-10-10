import type { Savings, TurnRow } from '../types'
import type { Price } from './pricing'
import { usd, writePrice } from './pricing'

// A handoff summary is a few thousand output tokens, when the compaction reports no usage.
const SUMMARY_TOKENS = 3000

export const NO_SAVINGS: Savings = {
  gross: 0,
  spent: 0,
  removed: 0,
  compactions: 0,
  isFresh: false,
  pastUsd: 0,
  pastCompactions: 0,
}

export const LEVELS = [
  { usd: 0, name: 'Cache Rookie' },
  { usd: 1, name: 'Context Trimmer' },
  { usd: 5, name: 'Token Saver' },
  { usd: 25, name: 'Cache Keeper' },
  { usd: 100, name: 'Context Master' },
  { usd: 500, name: 'Compaction Legend' },
] as const

export const net = (v: Savings) => v.gross - v.spent
export const lifetime = (v: Savings) => v.pastUsd + net(v)

/** The level a lifetime total has reached, and the next one up. */
export const level = (total: number) => {
  const i = LEVELS.findLastIndex(l => total >= l.usd)
  const at = Math.max(0, i)
  return { rank: at + 1, name: LEVELS[at]!.name, at: LEVELS[at]!.usd, next: LEVELS[at + 1] }
}

/** USD with a sign: a compaction costs before it pays back. */
export const signed = (n: number) => (n < 0 ? `−${usd(-n)}` : usd(n))

/**
 * One compaction: the tokens it took out, and its cost. That is the summarizer's request,
 * plus writing the new context to the cache on the next turn, where it would have been read.
 * After the cache expired the old context would have been re-written too: there the next
 * turn's write costs nothing extra, and the rebuild it avoids is credited by `carried`.
 */
export const compacted = (
  v: Savings,
  r: { tokensBefore: number; tokensAfter: number; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } },
  p: Price,
  ttl: string,
  isCold = false,
): Savings => {
  const summarizer = r.usage
    ? (r.usage.input_tokens * p.input +
        r.usage.output_tokens * p.output +
        r.usage.cache_read_input_tokens * p.read +
        r.usage.cache_creation_input_tokens * writePrice(p, ttl)) / 1e6
    : // Cold, the summarizer reads the context uncached: priced as a cache write, the dearer case.
      (r.tokensBefore * (isCold ? writePrice(p, ttl) : p.read) + SUMMARY_TOKENS * p.output) / 1e6
  const rewrite = isCold ? 0 : (r.tokensAfter * (writePrice(p, ttl) - p.read)) / 1e6
  return {
    ...v,
    spent: v.spent + summarizer + rewrite,
    removed: v.removed + Math.max(0, r.tokensBefore - r.tokensAfter),
    compactions: v.compactions + 1,
    isFresh: !isCold,
  }
}

/**
 * One turn since a compaction: what it would also have carried, priced as a cache read, or
 * as a write when the turn rebuilt a cold cache. Never more than the window could hold.
 */
export const carried = (v: Savings, turn: TurnRow, window: number, p: Price, ttl: string): Savings => {
  if (v.removed === 0) return v
  const extra = window > 0 ? Math.min(v.removed, Math.max(0, window - turn.ctx)) : v.removed
  const isRebuild = !v.isFresh && turn.ctx > 0 && turn.writeTokens >= 0.6 * turn.ctx
  return { ...v, gross: v.gross + (extra * (isRebuild ? writePrice(p, ttl) : p.read)) / 1e6, isFresh: false }
}

/** Turns until a compaction's cost is paid back, at the current saving per turn. */
export const payback = (v: Savings, perTurn: number) =>
  net(v) >= 0 || perTurn <= 0 ? 0 : Math.ceil(-net(v) / perTurn)
