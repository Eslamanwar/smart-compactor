import type { PanelState } from '../types'
import { sparkline } from './chart'
import { cacheState, hints, hitRatio, minutes } from './hints'
import { kTokens, priceOf, usd, writePrice } from './pricing'
import { level, lifetime, net, signed } from './savings'

const ICON = { critical: '▲', warning: '◆', info: '●' } as const

/**
 * The panel as plain text, for hosts that draw no plugin pane (the VS Code extension today):
 * `/cost-panel` answers with it, so it shows in the transcript. The model reads it too, so it
 * stays short.
 */
export const report = (s: PanelState, now: number, ttl: string, compactCommand: string) => {
  const p = priceOf(s.model)
  if (p === undefined || s.tokens === 0) return 'Cost & cache: send a message first; the report fills in after the first reply.'

  const cache = cacheState(s, now, ttl === '5m' ? 5 * 60_000 : 60 * 60_000)
  const rebuild = usd((s.tokens * writePrice(p, ttl)) / 1e6)
  const ratio = hitRatio(s)
  const share = s.window > 0 ? Math.round((s.tokens / s.window) * 100) : 0
  const recent = s.turns.slice(-20)
  const peak = recent.reduce<(typeof recent)[number] | undefined>(
    (a, t) => (a === undefined || t.read + t.write + t.output + t.input > a.read + a.write + a.output + a.input ? t : a),
    undefined,
  )

  const lines = [
    `Cost & cache · ${s.model} · ${ttl} cache`,
    cache === undefined
      ? '○ Cache state unknown until the next reply'
      : cache.isWarm
        ? `● Warm, expires in ${minutes(cache.remainingMs)} (rebuilding later costs ${rebuild})`
        : `○ Cold: the next message re-writes ${kTokens(s.tokens)} (${rebuild})`,
    `Context ${kTokens(s.tokens)} / ${kTokens(s.window)} (${share}%) · session ${usd(s.sessionUsd)} · cache hit ${ratio === undefined ? '–' : `${(ratio * 100).toFixed(1)}%`} · re-read ${usd((s.tokens * p.read) / 1e6)}/turn`,
  ]
  if (recent.length > 1 && peak !== undefined) {
    const peakUsd = peak.read + peak.write + peak.output + peak.input
    const what = peak.write > peakUsd / 2 ? ' cache rebuild' : ''
    lines.push(`Last ${recent.length} turns: ${sparkline(recent, 20)}  (peak ${usd(peakUsd)}${what})`)
  }

  const v = s.saved
  const lv = level(lifetime(v))
  lines.push(
    `Saved by compacting: ${v.compactions === 0 ? 'nothing yet this session' : `${signed(net(v))} this session (${v.compactions} compaction${v.compactions === 1 ? '' : 's'}, ${kTokens(v.removed)} less to re-read per turn)`} · ★ Level ${lv.rank} ${lv.name}, all time ${signed(lifetime(v))}`,
  )

  const list = hints(s, now, ttl).slice(0, 3)
  if (list.length === 0) lines.push('✓ Nothing to act on: the cache is doing its job.')
  for (const h of list) {
    lines.push(`${ICON[h.level]} ${h.title} (~${usd(h.stake)} at stake). ${h.detail}${h.action === 'compact' ? ` → /${compactCommand}` : ''}`)
  }
  return lines.join('\n')
}
