import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { priceOf } from '../hooks/pricing'
import { carried, compacted, NO_SAVINGS } from '../hooks/savings'

const PANE = { plugin: 'smart-compactor', component: 'Pane', requestId: 'cost-panel' } as const
const PROPS = { title: 'Cost & cache', isFocused: false, bodyColumns: 90, placement: 'dock' } as never

// A 420K-token Opus 5 session (read $0.50/M, 1h write $10/M, output $25/M) that compacts to 20K.
const world = (on: On, store: Record<string, unknown> = {}) => {
  const toasts: string[] = []
  const logs: string[] = []
  const clock = mock.clock(on)
  // The plugin's store, in memory and readable by the test.
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }))
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 420_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 12.4 } } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => (e.to === 'debug' || logs.push(e.text), { value: undefined }))
  on('session.compact', () => ({
    messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never,
    tokensBefore: 420_000,
    tokensAfter: 20_000,
    usage: { input_tokens: 0, output_tokens: 2000, cache_read_input_tokens: 420_000, cache_creation_input_tokens: 0 } as never,
  }))
  on('prompt.suggest', () => ({ isShown: true }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, toasts, logs, store }
}

const reply = async ($: Parameters<TestBody>[0], n = 1) => {
  for (let i = 0; i < n; i++) {
    await $.turn.start({ text: 'go', turnId: `t${i}` })
    await $.turn.complete({
      answer: 'done', durationMs: 1, isAborted: false, turnId: `t${i}`, reason: 'answer',
      usage: { input_tokens: 10, output_tokens: 800, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000, model: 'claude-opus-5' },
    })
  }
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

// Compacting 420K → 20K costs $0.26 (the summarizer reads 420K, writes 2K) + $0.19 (re-writing
// 20K to the cache) = $0.45, and saves 400K × $0.50/M = $0.20 on every turn after it.
test('a compaction starts in the red and pays for itself on the third turn', async ($, on) => {
  const w = world(on)
  await reply($)
  const { text } = await $.command.run({ command: 'smart-compact' } as never)
  expect(text).toMatch(/compacting with a handoff summary/)
  await w.clock.advance(200)
  expect(w.logs.at(-1)).toMatch(/manual → compacted 420K → 20K, summarizer read 420K from cache · saves ~\$0\.20 per turn/)

  await reply($)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '−$0.25' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pays for itself in 2 more turns/ })).toBeDefined()
  await ui.unmount()

  await reply($, 2)
  expect(w.toasts.at(-1)).toMatch(/Compaction paid for itself: \$0\.15 saved this session/)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '$0.15' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 compaction · 400K less to re-read, ~\$0\.20 per turn/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Level 1: Cache Rookie/ })).toBeDefined()
})

// Past the 1-hour TTL the next turn would re-write all 420K anyway: the compaction's re-write of
// 20K costs nothing extra, so it costs only the summarizer, $0.26, and is −$0.06 after one turn.
test('a compaction after the cache expired is not charged for re-writing the cache', async ($, on) => {
  const w = world(on)
  await reply($)
  await w.clock.advance(61 * 60_000)
  await $.command.run({ command: 'smart-compact' } as never)
  await w.clock.advance(200)
  await reply($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '−$0.06' })).toBeDefined()
})

// Without usage from the summarizer: warm, it reads 420K from cache ($0.21) and writes a 3K
// summary ($0.075), then the next turn writes 20K where it would have read it ($0.19). Cold, the
// read is a write ($4.20) and the re-write is free; the next turn, a rebuild, credits 400K × $10/M.
test('the savings model prices a cold compaction against the rebuild it avoids', () => {
  const p = priceOf('claude-opus-5')!
  const mills = (n: number) => Math.round(n * 1000) / 1000
  const r = { tokensBefore: 420_000, tokensAfter: 20_000 }
  const rebuild = { at: 0, model: 'claude-opus-5', ctx: 20_000, readTokens: 0, writeTokens: 20_000, read: 0, write: 0, output: 0, input: 0 }

  const warm = compacted(NO_SAVINGS, r, p, '1h')
  expect(mills(warm.spent)).toBe(0.475)
  expect(mills(carried(warm, rebuild, 1_000_000, p, '1h').gross)).toBe(0.2)

  const cold = compacted(NO_SAVINGS, r, p, '1h', true)
  expect(mills(cold.spent)).toBe(4.275)
  expect(mills(carried(cold, rebuild, 1_000_000, p, '1h').gross)).toBe(4)
})

test('before any compaction the panel says nothing is saved yet', async ($, on) => {
  world(on)
  await reply($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Nothing yet this session/ })).toBeDefined()
})

test('earlier runs count toward the level; crossing one toasts, and this run is stored', async ($, on) => {
  const w = world(on, { 'run:old:1': { usd: 4.5, compactions: 3 } })
  await start($)
  await reply($)
  await $.command.run({ command: 'smart-compact' } as never)
  await w.clock.advance(200)
  await reply($, 5) // net 5 × $0.20 − $0.45 = $0.55: all time $5.05
  expect(w.toasts.at(-1)).toMatch(/★ Level 3: Token Saver\. Compacting has saved you \$5\.05/)
  const mine = Object.entries(w.store).find(([k]) => k.startsWith('run:sess-1:'))
  expect(mine?.[1]).toMatchObject({ compactions: 1 })

  const { text } = await $.command.run({ command: 'cost-panel' } as never)
  expect(text).toMatch(/Saved by compacting: \$0\.55 this session \(1 compaction, 400K less to re-read per turn\) · ★ Level 3 Token Saver, all time \$5\.05/)
})

const hostCompact = ($: Parameters<TestBody>[0], trigger: 'auto' | 'manual') =>
  $.session.compact({ trigger, messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)

test('your own /compact counts; autocompact, which would have run anyway, does not', async ($, on) => {
  world(on)
  await reply($)
  await hostCompact($, 'auto')
  await reply($, 3)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Nothing yet this session/ })).toBeDefined()
  await ui.unmount()

  await hostCompact($, 'manual')
  await reply($)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /1 compaction · 400K less to re-read/ })).toBeDefined()
})

test('compacting from the task-boundary hint clears the hint', { options: { mode: 'suggest' } }, async ($, on) => {
  world(on)
  await $.turn.start({ text: 'ship it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  await $.turn.complete({
    answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 800, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000, model: 'claude-opus-5' },
  })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Task finished \(commit\)/ })).toBeDefined()
  await ui.press({ key: 'compact-boundary' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 compaction/ })).toBeDefined()
})
