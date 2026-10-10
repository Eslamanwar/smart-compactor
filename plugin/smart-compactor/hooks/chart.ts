import type { TurnRow } from '../types'
import { kTokens, usd } from './pricing'

// Categorical slots 1-4 of the reference palette, validated as adjacent stack pairs in both
// modes. Light aqua and yellow sit under 3:1 on the surface, so the panel adds a text
// breakdown of the last turn beside the chart (the relief rule).
export const SERIES = [
  { key: 'read', label: 'Cache read', light: '#2a78d6', dark: '#3987e5' },
  { key: 'write', label: 'Cache write', light: '#eb6834', dark: '#d95926' },
  { key: 'output', label: 'Output', light: '#1baf7a', dark: '#199e70' },
  { key: 'input', label: 'Uncached input', light: '#eda100', dark: '#c98500' },
] as const

const SLOTS = 30
const W = 560
const H = 180
const M = { top: 30, right: 8, bottom: 20, left: 44 }
const GAP = 2

const total = (t: TurnRow) => t.read + t.write + t.output + t.input

const niceMax = (n: number) => {
  if (n <= 0) return 0.01
  const step = 10 ** Math.floor(Math.log10(n))
  return [1, 2, 2.5, 5, 10].map(m => m * step).find(v => v >= n) ?? n
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A column segment whose top corners are rounded (the data end), square at the bottom.
const topRounded = (x: number, y: number, w: number, h: number, cls: string) => {
  const r = Math.min(4, h, w / 2)
  return `<path class="${cls}" d="M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z"/>`
}

/** Stacked cost per turn, newest on the right, as one SVG document. */
export const costChart = (turns: readonly TurnRow[]) => {
  const shown = turns.slice(-SLOTS)
  const max = niceMax(Math.max(...shown.map(total)))
  const plotW = W - M.left - M.right
  const plotH = H - M.top - M.bottom
  const slot = plotW / SLOTS
  const barW = Math.min(24, Math.max(4, slot * 0.6))
  const base = M.top + plotH
  const y = (v: number) => (v / max) * plotH

  const grid = [0, max / 2, max]
    .map(v => {
      const gy = base - y(v)
      return `<line class="${v === 0 ? 'b' : 'g'}" x1="${M.left}" x2="${W - M.right}" y1="${gy}" y2="${gy}"/>` +
        `<text class="mu num" x="${M.left - 6}" y="${gy + 4}" text-anchor="end">${v === 0 ? '$0' : usd(v)}</text>`
    })
    .join('')

  const bars = shown
    .map((t, i) => {
      const x = M.left + (SLOTS - shown.length + i) * slot + (slot - barW) / 2
      const parts = SERIES.map((s, k) => ({ cls: `c${k + 1}`, h: y(t[s.key]) })).filter(p => p.h >= 0.5)
      let top = base
      const marks = parts
        .map((p, k) => {
          const h = k === 0 ? p.h : p.h - GAP
          top -= p.h
          if (h < 0.5) return ''
          const yTop = top
          return k === parts.length - 1
            ? topRounded(x, yTop, barW, h, p.cls)
            : `<rect class="${p.cls}" x="${x}" y="${yTop}" width="${barW}" height="${h}"/>`
        })
        .join('')
      const tip = [
        `Turn ${turns.length - shown.length + i + 1}: ${usd(total(t))}, ${kTokens(t.ctx)} context`,
        ...SERIES.map(s => `${s.label}: ${usd(t[s.key])}`),
      ].join('\n')
      const hitX = M.left + (SLOTS - shown.length + i) * slot
      return `<g class="bar"><title>${esc(tip)}</title><rect class="hit" x="${hitX}" y="${M.top}" width="${slot}" height="${plotH}"/>${marks}</g>`
    })
    .join('')

  // One direct label, on the most expensive turn: the story is usually a cache rebuild.
  const peakIndex = shown.reduce((best, t, i) => (total(t) > total(shown[best]!) ? i : best), 0)
  const peak = shown[peakIndex]
  const peakLabel = peak === undefined ? '' : (() => {
    const cx = M.left + (SLOTS - shown.length + peakIndex) * slot + slot / 2
    const what = peak.write > total(peak) / 2 ? ' cache rebuild' : ''
    const anchor = cx > W - 90 ? 'end' : cx < M.left + 60 ? 'start' : 'middle'
    return `<text class="t2 num" x="${cx}" y="${base - y(total(peak)) - 6}" text-anchor="${anchor}">${usd(total(peak))}${what}</text>`
  })()

  let lx = M.left
  const legend = SERIES.map((s, k) => {
    const item = `<rect class="c${k + 1}" x="${lx}" y="8" width="10" height="10" rx="2"/><text class="t2" x="${lx + 14}" y="17">${s.label}</text>`
    lx += 14 + s.label.length * 5.9 + 18
    return item
  }).join('')

  const light = SERIES.map((s, k) => `.c${k + 1}{fill:${s.light}}`).join('')
  const dark = SERIES.map((s, k) => `.c${k + 1}{fill:${s.dark}}`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<style>text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif}.num{font-variant-numeric:tabular-nums}` +
    `.s{fill:#fcfcfb}.t2{fill:#52514e}.mu{fill:#898781}.g{stroke:#e1e0d9;stroke-width:1}.b{stroke:#c3c2b7;stroke-width:1}` +
    `.hit{fill:transparent}g.bar:hover .hit{fill:rgba(137,135,129,.14)}${light}` +
    `@media (prefers-color-scheme: dark){.s{fill:#1a1a19}.t2{fill:#c3c2b7}.g{stroke:#2c2c2a}.b{stroke:#383835}${dark}}</style>` +
    `<rect class="s" width="${W}" height="${H}" rx="6"/>${legend}${grid}${bars}${peakLabel}` +
    `<text class="mu" x="${W - M.right}" y="${H - 5}" text-anchor="end">last ${shown.length} turn${shown.length === 1 ? '' : 's'}, newest right</text>` +
    `</svg>`
}

export const chartAlt = (turns: readonly TurnRow[]) => {
  const shown = turns.slice(-SLOTS)
  const sum = shown.reduce((n, t) => n + total(t), 0)
  const peak = shown.reduce((a, t) => (total(t) > total(a) ? t : a), shown[0] ?? turns[0]!)
  return `Cost per turn for the last ${shown.length} turns: ${usd(sum)} in all, the most expensive ${usd(total(peak))}.`
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** The terminal's stand-in for the chart: one block per turn, height by cost. */
export const sparkline = (turns: readonly TurnRow[], width: number) => {
  const shown = turns.slice(-Math.max(1, width))
  const max = Math.max(...shown.map(total), 1e-9)
  return shown.map(t => BLOCKS[Math.min(7, Math.round((total(t) / max) * 7))]).join('')
}

/** A text meter: filled cells for the share used, light cells for the rest. */
export const meter = (share: number, cells: number) => {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * cells)
  return { filled: '█'.repeat(filled), track: '░'.repeat(cells - filled) }
}
