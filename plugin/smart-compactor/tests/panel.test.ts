import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const PANE = { plugin: 'smart-compactor', component: 'Pane', requestId: 'cost-panel' } as const
// The kit fills the scroll and view handles a live pane carries.
const PROPS = { title: 'Cost & cache', isFocused: false, bodyColumns: 90, placement: 'dock' } as never

// The engine beneath the plugin for a 420K-token Opus 5 session with a 1h cache.
const world = (on: On) => {
  const compacts: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 420_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 12.4 } } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.compact', ($, e) => {
    compacts.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: 420_000, tokensAfter: 20_000 }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, compacts }
}

const reply = async ($: Parameters<TestBody>[0]) => {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({
    answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { input_tokens: 10, output_tokens: 800, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000, model: 'claude-opus-5' },
  })
}

test('the panel draws on every surface: VS Code gets the SVG chart, the terminal a sparkline', async ($, on) => {
  world(on)
  await reply($)
  for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
    expect(await ui.find({ type: 'Text', text: /● Warm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in 60 min/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$12.4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /95\.2%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Large context: 420K/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /claude-opus-5-5 reads the cache 60% cheaper/ })).toBeDefined()
    const svg = await ui.find({ type: 'Svg' })
    if (surface === 'terminal') expect(svg).toBeUndefined()
    else expect(svg).toBeDefined()
    await ui.unmount()
  }
})

test('near expiry the top hint says so, and its button compacts with the handoff prompt', async ($, on) => {
  const { clock, compacts } = world(on)
  await reply($)
  await clock.advance(55 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Cache expires in 5 min/ })).toBeDefined()
  await ui.press({ key: 'compact-expiring' })
  expect(compacts).toHaveLength(1)
  expect(compacts[0]).toMatch(/Open work and follow-ups/)
})

test('past the TTL the cache reads cold with the rebuild cost', async ($, on) => {
  const { clock } = world(on)
  await reply($)
  await clock.advance(61 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /○ Cold/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeDefined()
})

test('dismissing a hint removes it', async ($, on) => {
  world(on)
  await reply($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  await ui.press({ key: 'dismiss-large' })
  expect(await ui.find({ type: 'Text', text: /Large context/ })).toBeUndefined()
})

test('without a terminal (the VS Code extension), /cost-panel answers with the text report', async ($, on) => {
  world(on)
  on('session.surfaces', () => ({ value: ['vscode'] }))
  await reply($)
  const { text } = await $.command.run({ command: 'cost-panel' } as never)
  expect(text).toMatch(/● Warm, expires in 60 min/)
  expect(text).toMatch(/cache hit 95\.2%/)
  expect(text).toMatch(/Large context: 420K/)
  expect(text).toMatch(/→ \/smart-compact/)
})
