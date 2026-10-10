import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const BAND = { plugin: 'smart-compactor', component: 'AbovePrompt' } as const
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 } as never

// A session that wrote and committed a feature: the judge reads this at the next prompt.
const HISTORY = [
  { role: 'user', text: 'add a retry to the payments client', toolUses: [] },
  { role: 'assistant', text: 'Added the retry.', toolUses: [{ tool_use_id: 'a', tool: 'Edit', input: { file_path: '/repo/src/client.ts' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok' }] },
  { role: 'user', text: 'commit it<system-reminder>noise</system-reminder>', toolUses: [] },
  { role: 'assistant', text: 'Committed as 3f2a1c on main.', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'git commit -m x' } }] },
]

type Ask = { model: string; system?: string; prompt: string }
type World = {
  asks: Ask[]
  compacts: (string | undefined)[]
  toasts: string[]
  logs: string[]
  entered: string[]
  store: Record<string, unknown>
  clock: ReturnType<typeof mock.clock>
  reply: { text?: string; fail?: true }
}

const world = (on: On, tokens = 420_000, store: Record<string, unknown> = {}): World => {
  const w: World = { asks: [], compacts: [], toasts: [], logs: [], entered: [], store, clock: mock.clock(on), reply: {} }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: 'claude-opus-5' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: HISTORY as never }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => (e.to === 'debug' || w.logs.push(e.text), { value: undefined }))
  on('model.complete', ($, e) => {
    w.asks.push({ model: e.model, system: e.system, prompt: e.prompt })
    const usage = { input_tokens: 1500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return {
      value: w.reply.fail
        ? ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } as never)
        : { isAnswered: true, text: w.reply.text ?? '', usage },
    }
  })
  on('session.compact', ($, e) => {
    w.compacts.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: tokens, tokensAfter: 20_000 }
  })
  on('prompt.submit', ($, e) => (w.entered.push(e.text), { text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, () => h('Box', {}) as never)
  return w
}

// The person sends a prompt; a compaction the plugin defers has run by the time this resolves.
const say = async ($: Parameters<TestBody>[0], w: World, text: string, origin: 'composer' | 'task-notification' | 'sdk' = 'composer') => {
  const r = await $.prompt.submit({ text, wait: false, origin: { kind: origin } } as never)
  await w.clock.advance(200)
  return r
}

test('a natural break: Sonnet is asked; the prompt waits for the compaction, is sent again, and a rating is asked for', async ($, on) => {
  const w = world(on)
  w.reply.text = '{"break": true, "confidence": 0.8}'
  const held = await say($, w, 'now write the README for the new CLI')
  expect(held).toEqual({ drop: 'smart-compactor: a natural break (sonnet 0.80 ≥ 0.50). Compacting first, then sending your prompt.' })

  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.model).toBe('sonnet')
  expect(w.asks[0]!.system).toMatch(/NATURAL BREAK/)
  expect(w.asks[0]!.prompt).toMatch(/Session started with: add a retry to the payments client/)
  expect(w.asks[0]!.prompt).toMatch(/- commit it\n/)
  expect(w.asks[0]!.prompt).not.toMatch(/system-reminder/)
  expect(w.asks[0]!.prompt).toMatch(/Agent's last answer began: Committed as 3f2a1c on main\./)
  expect(w.asks[0]!.prompt).toMatch(/NEW prompt: now write the README for the new CLI/)

  expect(w.compacts).toHaveLength(1)
  expect(w.compacts[0]).toMatch(/task boundary \(natural break\)/)
  expect(w.compacts[0]).toMatch(/The next task starts with this prompt.*now write the README/)
  expect(w.entered).toEqual(['now write the README for the new CLI'])
  expect(w.logs.at(-1)).toMatch(/natural break → compacted 420K → 20K .* sonnet 0\.80 ≥ 0\.50 · rate it: \/smart-compact-rate up\|down/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface, props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /Compacted at a natural break \(sonnet, 0\.80\)\. Right call\?/ })).toBeDefined()
    await ui.unmount()
  }
})

test('👎 is stored with its digest, raises the bar, and the next judgment sees it as an example', async ($, on) => {
  const w = world(on)
  w.reply.text = '{"break": true, "confidence": 0.8}'
  await say($, w, 'now write the README')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: BAND_PROPS })
  await ui.press({ key: 'rate-bad' })
  expect(w.toasts.at(-1)).toMatch(/👎 saved\. .* compacts at confidence ≥ 0\.55/)
  expect(await ui.find({ type: 'Text', text: /Right call/ })).toBeUndefined()

  const [key, rating] = Object.entries(w.store).find(([k]) => k.startsWith('rating:sess-1:'))!
  expect(key).toMatch(/^rating:sess-1:\d+$/)
  expect(rating).toMatchObject({ isGood: false, confidence: 0.8, digest: { newPrompt: 'now write the README' }, project: '/repo' })

  // 0.52 cleared the old bar of 0.50, not the learned 0.55.
  w.reply.text = '{"break": true, "confidence": 0.52}'
  await say($, w, 'and add a changelog entry')
  expect(w.asks).toHaveLength(2)
  expect(w.asks[1]!.prompt).toMatch(/<rated verdict="wrong: the work was still going">\n[\s\S]*NEW prompt: now write the README\n<\/rated>/)
  expect(w.asks[1]!.prompt).toMatch(/<item>\n[\s\S]*NEW prompt: and add a changelog entry/)
  expect(w.compacts).toHaveLength(1)
  expect(w.entered).toHaveLength(2)
})

test('/smart-compact-rate up stores a 👍; without a compaction to rate it says so', async ($, on) => {
  const w = world(on)
  let { text } = await $.command.run({ command: 'smart-compact-rate', args: 'up' } as never)
  expect(text).toMatch(/no automatic compaction to rate/)

  w.reply.text = '{"break": true, "confidence": 0.9}'
  await say($, w, 'new thing')
  ;({ text } = await $.command.run({ command: 'smart-compact-rate', args: 'up' } as never))
  expect(text).toMatch(/👍 saved\. .* compacts at confidence ≥ 0\.50/)
  expect(Object.values(w.store)).toEqual([expect.objectContaining({ isGood: true })])
  ;({ text } = await $.command.run({ command: 'smart-compact-rate', args: 'maybe' } as never))
  expect(text).toMatch(/Usage: \/smart-compact-rate up\|down/)
})

test('the bar learns from stored ratings: two 👎 make it 0.60, 👍 take it back, never below where it starts', async ($, on) => {
  const digest = { taskStart: 't', previous: [], files: [], lastAnswer: '', newPrompt: 'p' }
  const store: Record<string, unknown> = {
    'rating:a:1': { at: 1, isGood: false, confidence: 0.7, digest, project: '/repo' },
    'rating:a:2': { at: 2, isGood: false, confidence: 0.6, digest, project: '/repo' },
  }
  const w = world(on, 420_000, store)
  w.reply.text = '{"break": true, "confidence": 0.58}'
  await say($, w, 'next')
  expect(w.compacts).toHaveLength(0)
  expect(w.asks[0]!.prompt.match(/<rated /g)).toHaveLength(2)

  for (let i = 3; i < 13; i++) store[`rating:a:${i}`] = { at: i, isGood: true, confidence: 0.6, digest, project: '/repo' }
  await say($, w, 'next')
  expect(w.compacts).toHaveLength(1)
  // Three of each kind at most, so the prompt stays short.
  expect(w.asks[1]!.prompt.match(/<rated /g)).toHaveLength(5)
})

test('ratings from another project move the bar, but their prompts never reach this judge', async ($, on) => {
  const elsewhere = { taskStart: 'secret plan', previous: [], files: [], lastAnswer: '', newPrompt: 'other repo prompt' }
  const store: Record<string, unknown> = {
    'rating:b:1': { at: 1, isGood: false, confidence: 0.7, digest: elsewhere, project: '/other' },
    // Rated before ratings carried a project: kept out of every judge's prompt.
    'rating:b:2': { at: 2, isGood: false, confidence: 0.6, digest: elsewhere },
  }
  const w = world(on, 420_000, store)
  w.reply.text = '{"break": true, "confidence": 0.58}'
  await say($, w, 'next')
  expect(w.asks[0]!.prompt).not.toMatch(/<rated |secret plan|other repo prompt/)
  expect(w.compacts).toHaveLength(0)
})

test('no compaction when the judge says it is not a break, is unsure, fails or replies with something else', async ($, on) => {
  const w = world(on)
  for (const reply of [{ text: '{"break": false, "confidence": 0.9}' }, { text: '{"break": true, "confidence": 0.3}' }, { fail: true as const }, { text: 'yes' }]) {
    w.reply = reply
    await say($, w, 'fix the failing case')
  }
  expect(w.asks).toHaveLength(4)
  expect(w.compacts).toHaveLength(0)
  expect(w.entered).toHaveLength(4)
})

test('the judge is not asked below minTokens', async ($, on) => {
  const w = world(on, 90_000)
  w.reply.text = '{"break": true, "confidence": 0.9}'
  await say($, w, 'next')
  expect(w.asks).toHaveLength(0)
  expect(w.entered).toEqual(['next'])
})

test('the judge is not asked for slash commands or for prompts the person did not send', async ($, on) => {
  const w = world(on)
  w.reply.text = '{"break": true, "confidence": 0.9}'
  await say($, w, '/review')
  await say($, w, 'Background task finished', 'task-notification')
  expect(w.asks).toHaveLength(0)
  expect(w.entered).toEqual(['/review', 'Background task finished'])
})

test('a prompt with an image or an @-mention is never held back, so it is not judged', async ($, on) => {
  const w = world(on)
  w.reply.text = '{"break": true, "confidence": 0.9}'
  await say($, w, 'review @src/client.ts')
  await $.prompt.submit({ text: 'what is this?', attachments: [{ type: 'image' }], wait: false, origin: { kind: 'composer' } } as never)
  expect(w.asks).toHaveLength(0)
  expect(w.entered).toEqual(['review @src/client.ts', 'what is this?'])
})

test('judge=haiku asks Haiku and starts at its 0.8 bar', { options: { judge: 'haiku' } }, async ($, on) => {
  const w = world(on)
  w.reply.text = '{"break": true, "confidence": 0.75}'
  await say($, w, 'next')
  expect(w.asks[0]!.model).toBe('haiku')
  expect(w.compacts).toHaveLength(0)
})

test('judge=off and suggest mode never ask a judge', { options: { mode: 'suggest' } }, async ($, on) => {
  const w = world(on)
  await say($, w, 'next')
  expect(w.asks).toHaveLength(0)
})

test('an SDK host (VS Code, -p) is never held back: there a commit compacts, as with judge=off', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  w.reply.text = '{"break": true, "confidence": 0.9}'
  await say($, w, 'commit it', 'sdk')
  expect(w.asks).toHaveLength(0)
  expect(w.entered).toEqual(['commit it'])

  await $.turn.start({ text: 'commit it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.advance(2000)
  expect(w.compacts).toHaveLength(1)
  expect(w.compacts[0]).toMatch(/task boundary \(commit\)/)
})
