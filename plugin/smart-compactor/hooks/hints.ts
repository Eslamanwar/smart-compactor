import type { PanelState } from '../types'
import { cheaperModel, kTokens, priceOf, usd, writePrice } from './pricing'

export type Level = 'critical' | 'warning' | 'info'

export type Hint = {
  id: string
  level: Level
  title: string
  detail: string
  /** Estimated USD at stake, used to rank the hints. */
  stake: number
  action?: 'compact'
}

export type CacheState = { isWarm: boolean; remainingMs: number }

// A handoff summary is a few thousand output tokens.
const SUMMARY_TOKENS = 3000
// How many more turns a session is assumed to run, for "per turn" stakes.
const HORIZON = 10

export const cacheState = (s: PanelState, now: number, ttlMs: number): CacheState | undefined => {
  if (s.lastActivityAt === undefined) return undefined
  const remainingMs = s.lastActivityAt + ttlMs - now
  return { isWarm: remainingMs > 0, remainingMs: Math.max(0, remainingMs) }
}

export const hitRatio = (s: PanelState) => {
  const read = s.turns.reduce((n, t) => n + t.readTokens, 0)
  const write = s.turns.reduce((n, t) => n + t.writeTokens, 0)
  return read + write === 0 ? undefined : read / (read + write)
}

export const minutes = (ms: number) => (ms < 60_000 ? '<1 min' : `${Math.floor(ms / 60_000)} min`)

/** Every hint that applies now, most money at stake first, dismissed ones left out. */
export const hints = (s: PanelState, now: number, ttl: string): Hint[] => {
  const p = priceOf(s.model)
  if (p === undefined || s.tokens === 0) return []
  const ttlMs = ttl === '5m' ? 5 * 60_000 : 60 * 60_000
  const ctx = kTokens(s.tokens)
  const carry = (s.tokens * p.read) / 1e6
  const rebuild = (s.tokens * writePrice(p, ttl)) / 1e6
  const compactNow = carry + (SUMMARY_TOKENS * p.output) / 1e6
  const cache = cacheState(s, now, ttlMs)
  const out: Hint[] = []

  if (s.boundary !== undefined && s.tokens >= 50_000) {
    const turns = Math.max(1, Math.ceil(compactNow / carry))
    out.push({
      id: 'boundary',
      level: 'warning',
      title: `Task finished (${s.boundary}): compact while the cache is warm`,
      detail: `Carrying ${ctx} costs ${usd(carry)} per turn. A handoff compaction costs about ${usd(compactNow)} now and pays for itself in ${turns} turn${turns === 1 ? '' : 's'}.`,
      stake: carry * HORIZON,
      action: 'compact',
    })
  }

  if (cache?.isWarm && cache.remainingMs < 10 * 60_000 && s.tokens >= 100_000) {
    out.push({
      id: 'expiring',
      level: 'critical',
      title: `Cache expires in ${minutes(cache.remainingMs)}`,
      detail: `After that, your next message re-writes ${ctx} (${usd(rebuild)}). Reply now, compact (about ${usd(compactNow)}), or /clear before you step away.`,
      stake: rebuild,
      action: 'compact',
    })
  }

  if (cache !== undefined && !cache.isWarm && s.tokens >= 100_000) {
    out.push({
      id: 'cold',
      level: 'warning',
      title: 'Cache is cold',
      detail: `Your next message re-writes ${ctx} (${usd(rebuild)}). Starting something new? /clear and restate the task instead.`,
      stake: rebuild,
    })
  }

  const [prev, last] = s.turns.slice(-2)
  if (last !== undefined && last.ctx >= 50_000 && last.writeTokens >= 0.6 * last.ctx) {
    const wasIdle = prev === undefined || last.at - prev.at >= ttlMs
    const switched = prev !== undefined && prev.model !== last.model
    if (!wasIdle) {
      out.push({
        id: `rebuild-${last.at}`,
        level: 'warning',
        title: `Unexpected cache rebuild: ${usd(last.write)}`,
        detail: switched
          ? `The model changed (${prev?.model} → ${last.model}), and each model has its own cache. Pick the model at the start of a session.`
          : 'The cache was warm, but the prefix was re-written. Usual causes: an effort or fast-mode change, or an MCP server or plugin change mid-session.',
        stake: last.write,
      })
    }
  }

  if (s.tokens >= 300_000) {
    out.push({
      id: 'large',
      level: 'warning',
      title: `Large context: ${ctx} is re-read on every turn`,
      detail: `That's ${usd(carry)} per turn before Claude writes anything. /compact at the next break, or /clear between tasks.`,
      stake: carry * HORIZON,
      action: 'compact',
    })
  }

  const cheaper = cheaperModel(s.model)
  const cheaperPrice = cheaper === undefined ? undefined : priceOf(cheaper)
  if (cheaper !== undefined && cheaperPrice !== undefined && cheaperPrice.read < p.read) {
    const saved = Math.round((1 - cheaperPrice.read / p.read) * 100)
    out.push({
      id: 'model',
      level: 'info',
      title: `${cheaper} reads the cache ${saved}% cheaper`,
      detail: `Start your next session on ${cheaper}. Switching mid-session re-writes ${ctx} (${usd(rebuild)}), so switch at a /clear, not now.`,
      stake: ((s.tokens * (p.read - cheaperPrice.read)) / 1e6) * HORIZON,
    })
  }

  if (s.bigOutput !== undefined && s.bigOutput.tokens >= 8_000) {
    const perTurn = (s.bigOutput.tokens * p.read) / 1e6
    out.push({
      id: 'output',
      level: 'info',
      title: `${s.bigOutput.tool} output added about ${kTokens(s.bigOutput.tokens)} tokens`,
      detail: `It stays in context and is re-read on every turn (${usd(perTurn)} per turn). Pipe long output through tail or grep, or ask for a summary.`,
      stake: perTurn * HORIZON,
    })
  }

  return out.filter(h => !s.dismissed.includes(h.id)).sort((a, b) => b.stake - a.stake)
}
