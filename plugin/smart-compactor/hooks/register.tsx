import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { PanelState, Rating, Savings, Unrated } from '../types'
import { chartAlt, costChart, meter, SERIES, sparkline } from './chart'
import { cacheState, hints, hitRatio, minutes } from './hints'
import type { Hint } from './hints'
import { digest, examples, JUDGES, prompt, SYSTEM, threshold, verdict } from './judge'
import type { Judge } from './judge'
import { costSplit, kTokens, priceOf, usd, writePrice } from './pricing'
import { report } from './report'
import { carried, compacted, level, lifetime, net, NO_SAVINGS, payback, signed } from './savings'

type Boundary = 'pr' | 'push' | 'deploy' | 'commit' | 'tests' | 'validate' | 'build' | 'todos'

// git's global options may sit before the subcommand: `git -C <dir> commit`.
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--\S+))*\s+`

// Strongest first: a turn that commits and opens a PR reports `pr`.
const SIGNALS: readonly (readonly [Boundary, RegExp])[] = [
  ['pr', /\bgh\s+pr\s+(create|merge)\b/],
  ['push', new RegExp(`${GIT}push\\b`)],
  ['commit', new RegExp(`${GIT}commit\\b`)],
  ['deploy', /\bhelm\s+(upgrade|install)\b|\bkubectl\s+(apply|rollout\s+restart)\b(?!.*--dry-run)|\bterraform\s+apply\b|\bargocd\s+app\s+sync\b/],
  [
    'tests',
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\b(jest|vitest)\b|\bmake\s+test\b|\bgradlew?\b.*\btest\b|\bmvn\b.*\b(test|verify)\b/,
  ],
  ['validate', /\bhelm\s+(lint|template)\b|\bterraform\s+(validate|plan)\b|\bkubectl\b.*--dry-run|\bkubeconform\b|\bkustomize\s+build\b/],
  [
    'build',
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck)\b|\btsc\b|\bgo\s+(build|vet)\b|\bcargo\s+(build|check|clippy)\b|\bruff\b|\beslint\b/,
  ],
]

const RANK: Record<Boundary, number> = { pr: 0, push: 1, deploy: 2, commit: 3, tests: 4, validate: 5, build: 6, todos: 7 }

// Which signals count, by the `signals` setting; an offline replay study ranked them.
const SIGNAL_SETS: Record<string, readonly Boundary[]> = {
  git: ['pr', 'push', 'commit'],
  'git+deploy': ['pr', 'push', 'commit', 'deploy'],
  all: ['pr', 'push', 'deploy', 'commit', 'tests', 'validate', 'build', 'todos'],
}

const COMMAND = 'smart-compact'
const PANEL_COMMAND = 'cost-panel'
const RATE_COMMAND = 'smart-compact-rate'
const PANE = 'cost-panel'
const DEFER_MS = 1500
const COMMAND_DEFER_MS = 100
const TICK_MS = 30_000
const MAX_TURNS = 60
// A tool result at least this large (in tokens, ~4 characters each) is worth a hint.
const BIG_OUTPUT = 8_000
// The judge runs before the prompt enters; past this it lets the prompt through unjudged.
const JUDGE_TIMEOUT_MS = 15_000
const ttlMsOf = (ttl: string) => (ttl === '5m' ? 5 * 60_000 : 60 * 60_000)
// With the judge on, a boundary no prompt followed compacts this long after the turn: 55 minutes
// on the 1-hour cache, 4 on the 5-minute one, so the summarizer still reads it warm.
const beforeExpiryMs = (ttl: string) => ttlMsOf(ttl) - Math.min(5 * 60_000, ttlMsOf(ttl) / 5)
// Prompts the person typed, here or through the Remote Control bridge. An SDK host's prompt
// (the VS Code extension, -p) is never held back: a -p run ends with it, and the prompt is lost.
const PERSON = new Set(['composer', 'bridge'])
const MENTION = /(^|\s)@\S/

const panel = atom({ plugin: 'smart-compactor', key: 'panel' } as const, {
  turns: [],
  dismissed: [],
  tick: 0,
  tokens: 0,
  window: 0,
  sessionUsd: 0,
  model: '',
  saved: NO_SAVINGS,
} as PanelState)

// Each run of a session keeps its own entry in the store, so parallel sessions never race.
const RUN = 'run:'

/** Net savings and compactions of every earlier run, from the plugin's store. */
const pastRuns = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith(RUN))
  const runs = (await Promise.all(keys.map(k => $.store.get(k)))) as ({ usd?: number; compactions?: number } | undefined)[]
  const total = { usd: 0, compactions: 0 }
  for (const r of runs) {
    total.usd += r?.usd ?? 0
    total.compactions += r?.compactions ?? 0
  }
  return total
}

// Each rating of an automatic compaction is its own store entry, for the same reason.
const RATING = 'rating:'

const ratings = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(k => k.startsWith(RATING))
  return ((await Promise.all(keys.map(k => $.store.get(k)))) as (Rating | undefined)[]).filter(r => r !== undefined)
}

const persist = ($: EngineInterface, v: Savings, now: number) =>
  v.runKey === undefined || v.compactions === 0
    ? Promise.resolve()
    : $.store.set(v.runKey, { usd: net(v), compactions: v.compactions, at: now }).catch(() => undefined)

const LEVEL = {
  critical: { icon: '▲', color: 'error', word: 'Act now' },
  warning: { icon: '◆', color: 'warning', word: 'Worth it' },
  info: { icon: '●', color: 'suggestion', word: 'Tip' },
} as const

type Reason = Boundary | 'manual' | 'natural break'

export const handoff = (boundary: Reason, next?: string) =>
  [
    `This compaction runs at a task boundary (${boundary}). Write the summary as a handoff for the NEXT task, not a history of this one.`,
    ...(next === undefined ? [] : [`The next task starts with this prompt; keep what it will need: ${JSON.stringify(next.slice(0, 500))}`]),
    'Keep, in this order:',
    '1. What was just completed, in two or three sentences, with commit hashes, branch and PR links.',
    '2. Open work and follow-ups the user asked for or agreed to, verbatim where the user wrote them.',
    '3. Decisions, constraints and preferences the user stated that still apply.',
    '4. Files and paths that matter for the follow-up work.',
    '5. Anything still failing, skipped or unverified.',
    'Drop: dead ends, superseded plans, raw tool and test output, and file contents that can be read again.',
  ].join('\n')

export const detect = (command: string, allowed: readonly Boundary[] = SIGNAL_SETS.all!): Boundary | undefined =>
  SIGNALS.find(([b, re]) => allowed.includes(b) && re.test(command))?.[0]

// A todo list whose every item is done marks the end of the work it planned.
const isTodoDone = (input: unknown) => {
  const todos = (input as { todos?: { status?: string }[] } | undefined)?.todos ?? []
  return todos.length > 0 && todos.every(t => t.status === 'completed')
}

const stronger = (a: Boundary | undefined, b: Boundary) =>
  a === undefined || RANK[b] < RANK[a] ? b : a

/**
 * Settles a main-conversation compaction: the boundary and the big output are gone with the
 * context, and one the person or a plugin chose counts toward the savings.
 */
const settle = async (
  $: EngineInterface,
  r: { tokensBefore?: number; tokensAfter?: number; usage?: ModelUsage },
  counts: boolean,
  ttl: string,
) => {
  const now = await $.clock.now()
  return update($, panel, s => {
    const p = priceOf(s.model)
    const tokensBefore = r.tokensBefore ?? s.tokens
    // After the cache expired, as when the judge compacts at the first prompt back from a break.
    const isCold = cacheState(s, now, ttlMsOf(ttl))?.isWarm === false
    return {
      ...s,
      boundary: undefined,
      bigOutput: undefined,
      saved: counts && p !== undefined && tokensBefore > 0 && r.tokensAfter !== undefined
        ? compacted(s.saved, { tokensBefore, tokensAfter: r.tokensAfter, usage: r.usage }, p, ttl, isCold)
        : s.saved,
    }
  })
}

// The plugin's own compaction does not pass through its own session.compact hook: it settles here.
const compact = async ($: EngineInterface, boundary: Reason, ttl: string, next?: string) => {
  let r
  try {
    r = await $.session.compact({ instructions: handoff(boundary, next) })
  } catch (err) {
    if (!/headless/.test(String(err))) throw err
    // SDK hosts (the VS Code extension, -p) compact only as a command: run `/compact` itself.
    const tokensBefore = (await read($, panel)).tokens
    await $.command.run({ command: 'compact', args: handoff(boundary, next) })
    const tokensAfter = (await $.session.usage()).context.tokens
    await settle($, { tokensBefore, tokensAfter }, true, ttl)
    return { text: `smart-compactor: ${boundary} → ran /compact (SDK session)`, isCompacted: true }
  }
  if (r.skip !== undefined) return { text: `smart-compactor: skipped (${r.skip})`, isCompacted: false }
  await settle($, r, true, ttl)
  const before = r.tokensBefore === undefined ? '?' : kTokens(r.tokensBefore)
  const after = r.tokensAfter === undefined ? '?' : kTokens(r.tokensAfter)
  const cost = r.usage
    ? `, summarizer read ${kTokens(r.usage.cache_read_input_tokens ?? 0)} from cache`
    : ''
  const p = priceOf((await read($, panel)).model)
  const removed = (r.tokensBefore ?? 0) - (r.tokensAfter ?? r.tokensBefore ?? 0)
  const saves = p !== undefined && removed > 0 ? ` · saves ~${usd((removed * p.read) / 1e6)} per turn` : ''
  return { text: `smart-compactor: ${boundary} → compacted ${before} → ${after}${cost}${saves}`, isCompacted: true }
}

const compactAndLog = async ($: EngineInterface, ttl: string) => {
  try {
    $.ui.log((await compact($, 'manual', ttl)).text)
  } catch (err) {
    $.ui.toast(`smart-compactor: could not compact (${String(err)})`)
  }
}

/**
 * Compacts at a natural break the judge found, then sends the prompt it held back: the host
 * refuses a compaction under a prompt's own submission, so the prompt waits for it.
 */
const compactThenSend = async ($: EngineInterface, text: string, ttl: string, unrated: Unrated, why: string) => {
  try {
    const done = await compact($, 'natural break', ttl, text)
    $.ui.log(done.isCompacted ? `${done.text} · ${why} · rate it: /${RATE_COMMAND} up|down` : done.text)
    if (done.isCompacted) await update($, panel, s => ({ ...s, unrated }))
  } catch (err) {
    $.ui.log(`smart-compactor: could not compact (${String(err)})`)
  } finally {
    await $.prompt.submit({ text, asUser: true })
  }
}

/** Stores the person's rating of the last automatic compaction; the judge learns from it. */
const rate = async ($: EngineInterface, isGood: boolean, start: number | undefined) => {
  const { unrated } = await read($, panel)
  if (unrated === undefined) return 'smart-compactor: no automatic compaction to rate.'
  const rating: Rating = { at: unrated.at, isGood, confidence: unrated.confidence, digest: unrated.digest, project: unrated.project }
  await $.store.set(`${RATING}${await $.session.id()}:${unrated.at}`, rating)
  await update($, panel, s => ({ ...s, unrated: undefined }))
  const bar = threshold(start ?? unrated.threshold, await ratings($))
  return `smart-compactor: ${isGood ? '👍' : '👎'} saved. The judge sees this moment as an example from now on, and compacts at confidence ≥ ${bar.toFixed(2)}.`
}

/** The one-line summary for the status line, where no pane is drawn. */
const statusLine = (s: PanelState, now: number, ttl: string) => {
  const p = priceOf(s.model)
  if (p === undefined || s.tokens === 0) return undefined
  const cache = cacheState(s, now, ttlMsOf(ttl))
  const state = cache === undefined ? '' : cache.isWarm ? `cache warm ${minutes(cache.remainingMs)} · ` : 'cache cold · '
  return `${state}${kTokens(s.tokens)} ctx · ${usd((s.tokens * p.read) / 1e6)}/turn · /${PANEL_COMMAND}`
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'auto')
  const minTokens = Number(options.minTokens ?? 150000)
  const ttl = String(options.cacheTtl ?? '1h')
  const openPanel = options.openPanel !== false
  const allowed = SIGNAL_SETS[String(options.signals ?? 'git')] ?? SIGNAL_SETS.git!
  const judgeName = String(options.judge ?? 'sonnet')
  // In auto mode a judge, when one is set, decides at prompt time in place of the signals.
  const judge = judgeName in JUDGES ? JUDGES[judgeName as Judge] : undefined

  let pending: Boundary | undefined
  let isTurnRunning = false
  let cancelTimer: (() => void) | undefined
  const cancel = () => {
    cancelTimer?.()
    cancelTimer = undefined
  }
  let isPanePlaced = false
  // An SDK host sends its prompts as `sdk`; there the signals decide, as with judge=off.
  let isSdk = false

  on('session.start', async ($, e, next) => {
    $.ui.log(`smart-compactor: loaded (mode=${mode}, judge=${judge === undefined ? 'off' : judgeName}, minTokens=${minTokens}, ttl=${ttl})`, { to: 'debug' })
    await $.command.register({
      name: COMMAND,
      description: 'Compact now with a task-handoff summary (keeps open work, decisions, files).',
    })
    await $.command.register({
      name: RATE_COMMAND,
      description: 'Rate the last automatic compaction: up (a natural break) or down (the work was still going).',
      argumentHint: 'up|down',
    })
    await $.command.register({
      name: PANEL_COMMAND,
      description: 'Open the cost & cache panel: cache countdown, cost per turn, and hints.',
    })
    if (openPanel) {
      const opened = await $.ui.open({ id: PANE, title: 'Cost & cache' })
      isPanePlaced = opened.isPlaced
      $.ui.log(`smart-compactor: panel ${opened.isPlaced ? 'placed' : `waiting (${opened.reason})`}`, { to: 'debug' })
    }
    // Savings from earlier runs, for the all-time total and the level.
    try {
      const [id, now, past] = await Promise.all([$.session.id(), $.clock.now(), pastRuns($)])
      await update($, panel, s => ({
        ...s,
        saved: { ...s.saved, pastUsd: past.usd, pastCompactions: past.compactions, runKey: s.saved.runKey ?? `${RUN}${id}:${now}` },
      }))
    } catch (err) {
      $.ui.log(`smart-compactor: no saved totals (${String(err)})`, { to: 'debug' })
    }
    // Redraws the countdown; the status line carries it where no pane is drawn.
    $.clock.every(TICK_MS, () => {
      void update($, panel, s => ({ ...s, tick: s.tick + 1 }))
      if (isPanePlaced) return
      void Promise.all([read($, panel), $.clock.now()]).then(([s, now]) => {
        const line = statusLine(s, now, ttl)
        if (line !== undefined) $.ui.status(line)
      })
    })
    return next(e)
  })

  // The host refuses a compaction under the command's own turn: run it once the command returns.
  on('command.run', { command: COMMAND }, async $ => {
    $.clock.after(COMMAND_DEFER_MS, () => void compactAndLog($, ttl))
    return { text: 'smart-compactor: compacting with a handoff summary…' }
  })

  on('command.run', { command: RATE_COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (!/^(up|down|good|bad)$/.test(arg)) return { text: `Usage: /${RATE_COMMAND} up|down` }
    return { text: await rate($, arg === 'up' || arg === 'good', judge?.confidence) }
  })

  // Prompt time: the judge reads the new prompt. At a natural break the plugin holds the prompt
  // back, compacts, and sends it again, so it starts on the handoff summary.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'sdk') isSdk = true
    // A prompt for the model is back before the cache expired: the judge decides, not the timer.
    if (!e.text.trimStart().startsWith('/')) cancel()
    if (judge === undefined || mode !== 'auto' || isTurnRunning || e.turnId !== undefined) return next(e)
    if (!PERSON.has(e.origin.kind) || e.text.trimStart().startsWith('/')) return next(e)
    // A prompt sent again by a plugin loses its images and @-mentions: never hold one back.
    if (e.attachments?.length || MENTION.test(e.text)) return next(e)
    if (((await $.session.usage()).context.tokens ?? 0) < minTokens) return next(e)
    const d = digest(await $.session.messages(), e.text)
    if (d === undefined) return next(e)
    const [rated, project] = await Promise.all([ratings($), $.session.root()])
    // Every rating moves the bar, but only this project's digests are shown to the judge:
    // prompts from one project never reach another project's judge.
    const bar = threshold(judge.confidence, rated)
    const own = rated.filter(r => r.project === project)
    $.ui.status('smart-compactor: checking for a natural break…')
    try {
      const r = await $.model.complete({
        model: judge.model,
        system: SYSTEM,
        prompt: prompt(d, examples(own)),
        maxTokens: 100,
        effort: 'low',
        timeoutMs: JUDGE_TIMEOUT_MS,
      })
      // The judge's cost counts against what compacting saves.
      const p = priceOf(judge.priceAs)
      if (p !== undefined) {
        const u = r.usage
        const spent = (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.read
          + u.cache_creation_input_tokens * p.write5m) / 1e6
        await update($, panel, s => ({ ...s, saved: { ...s.saved, spent: s.saved.spent + spent } }))
      }
      const v = r.isAnswered ? verdict(r.text) : undefined
      const said = v === undefined ? `no verdict (${r.isAnswered ? 'unreadable reply' : r.reason})` : `break=${v.isBreak} confidence=${v.confidence}`
      $.ui.log(`smart-compactor: ${judgeName} judge ${said}, needs ${bar}`, { to: 'debug' })
      if (v?.isBreak && v.confidence >= bar) {
        const unrated: Unrated = { at: await $.clock.now(), judge: judgeName, confidence: v.confidence, threshold: bar, digest: d, project }
        const why = `${judgeName} ${v.confidence.toFixed(2)} ≥ ${bar.toFixed(2)}`
        $.clock.after(COMMAND_DEFER_MS, () => void compactThenSend($, e.text, ttl, unrated, why))
        return { drop: `smart-compactor: a natural break (${why}). Compacting first, then sending your prompt.` }
      }
    } finally {
      $.ui.status(undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a failed judge never holds the prompt back

  on('command.run', { command: PANEL_COMMAND }, async $ => {
    const [surfaces, s, now] = await Promise.all([$.session.surfaces(), read($, panel), $.clock.now()])
    // The VS Code extension draws no plugin pane yet: answer with the report as text there.
    if (!surfaces.includes('terminal')) return { text: report(s, now, ttl, COMMAND) }
    const opened = await $.ui.open({ id: PANE, title: 'Cost & cache' })
    isPanePlaced = opened.isPlaced
    return { text: opened.isPlaced ? 'Cost & cache panel opened.' : `Cost & cache panel is waiting: ${opened.reason}` }
  })

  on('session.measure', async ($, e, next) => {
    await update($, panel, s => ({
      ...s,
      tokens: e.context.tokens ?? s.tokens,
      window: e.context.window,
      sessionUsd: e.cost?.usd ?? s.sessionUsd,
    }))
    return next(e)
  })

  // Compactions the host runs: the person's /compact and autocompact, which would have run anyway.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.skip === undefined && e.trigger !== 'precompute') {
      await settle($, r, e.trigger !== 'auto', ttl)
    }
    return r
  }).catch(($, e, next) => next(e))

  // Only the main loop raises turn.start; a subagent's run raises none.
  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    cancel()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    const tokens = Math.round((ran.text?.length ?? 0) / 4)
    if (tokens >= BIG_OUTPUT) {
      await update($, panel, s => ({ ...s, bigOutput: { tool: String(e.tool), tokens } }))
    }
    if (mode === 'off') return ran
    const isOk = ran.deny === undefined && ran.isError !== true
    if (e.tool === 'TodoWrite' && isOk && allowed.includes('todos') && isTodoDone(e)) {
      pending = stronger(pending, 'todos')
      return ran
    }
    if (e.tool !== 'Bash') return ran
    const boundary = isOk ? detect(e.command, allowed) : undefined
    if (boundary !== undefined) pending = stronger(pending, boundary)
    $.ui.log(`smart-compactor: bash ok=${isOk} boundary=${boundary ?? 'none'}: ${e.command.slice(0, 60)}`, { to: 'debug' })
    return ran
  }).catch(($, e, next) => next(e)) // observe only: never block a tool

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false

    const boundary = pending
    pending = undefined
    const [usage, now, model] = await Promise.all([$.session.usage(), $.clock.now(), $.session.model()])
    const tokens = usage.context.tokens ?? 0
    const turnModel = e.usage?.model ?? model
    const p = priceOf(turnModel)

    let was = NO_SAVINGS
    const after = await update($, panel, s => {
      const turn = e.usage && p
        ? [{
            at: now,
            model: turnModel,
            ctx: tokens,
            readTokens: e.usage.cache_read_input_tokens,
            writeTokens: e.usage.cache_creation_input_tokens,
            ...costSplit(e.usage, p, ttl),
          }]
        : []
      was = s.saved
      return {
        ...s,
        saved: turn[0] && p ? carried(s.saved, turn[0], usage.context.window, p, ttl) : s.saved,
        turns: [...s.turns, ...turn].slice(-MAX_TURNS),
        lastActivityAt: e.usage ? now : s.lastActivityAt,
        model: turnModel,
        tokens: tokens || s.tokens,
        window: usage.context.window,
        sessionUsd: usage.cost?.usd ?? s.sessionUsd,
        boundary: mode === 'suggest' && boundary !== undefined && tokens >= minTokens ? boundary : s.boundary,
      }
    })

    const saved = after.saved
    if (saved.gross !== was.gross) {
      await persist($, saved, now)
      const [from, to] = [level(lifetime(was)), level(lifetime(saved))]
      if (to.rank > from.rank) {
        $.ui.toast(`★ Level ${to.rank}: ${to.name}. Compacting has saved you ${usd(lifetime(saved))} so far.`, { timeoutMs: 8000 })
      } else if (net(was) < 0 && net(saved) >= 0) {
        $.ui.toast(`Compaction paid for itself: ${usd(net(saved))} saved this session.`, { timeoutMs: 6000 })
      }
    }

    $.ui.log(`smart-compactor: turn.complete reason=${e.reason} boundary=${boundary ?? 'none'}`, { to: 'debug' })
    if (boundary === undefined || e.reason !== 'answer' || mode === 'off') return result

    $.ui.log(`smart-compactor: context ${tokens} tokens (min ${minTokens})`, { to: 'debug' })
    if (tokens < minTokens) return result

    if (mode === 'auto') {
      // With a judge, the signals no longer compact now: the judge decides at the next prompt.
      // If none comes before the cache expires, compact just before it does, while it is warm.
      if (judge !== undefined && !isSdk) {
        cancel()
        const timer = $.clock.after(beforeExpiryMs(ttl), () => {
          cancelTimer = undefined
          if (isTurnRunning) return
          // A /smart-compact since the boundary may have made the context small already.
          void $.session.usage()
            .then(async u => {
              if ((u.context.tokens ?? 0) < minTokens) return
              const r = await compact($, boundary, ttl)
              $.ui.log(r.isCompacted ? `${r.text} · idle, before the cache expired` : r.text)
            })
            .catch(err => $.ui.log(`smart-compactor: could not compact (${String(err)})`))
        })
        cancelTimer = () => timer.cancel()
        return result
      }
      // Compaction rejects while a turn runs; wait until this one has fully settled.
      const timer = $.clock.after(DEFER_MS, () => {
        cancelTimer = undefined
        if (isTurnRunning) return
        compact($, boundary, ttl)
          .then(r => $.ui.log(r.text))
          .catch(err => $.ui.log(`smart-compactor: could not compact (${String(err)})`))
      })
      cancelTimer = () => timer.cancel()
      return result
    }

    const carry = p === undefined ? '' : ` (~${usd((tokens * p.read) / 1e6)} per turn to carry)`
    $.ui.status(`task boundary (${boundary}) · ${kTokens(tokens)} ctx${carry} · /${COMMAND}`)
    // Hosts without toasts (VS Code) still show the prompt box's suggestion: Tab takes it.
    $.prompt.suggest({ text: `/${COMMAND}` }).catch(() => undefined)
    $.ui.toast(
      `Task boundary (${boundary}) with ${kTokens(tokens)} of context${carry}. Run /${COMMAND} now, while the cache is warm.`,
      { timeoutMs: 8000 },
    )
    return result
  })

  // Above the prompt after an automatic compaction: was it a natural break? The answer teaches the judge.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { unrated } = await read($, panel)
    if (unrated === undefined || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const press = (isGood: boolean) => () => void rate($, isGood, judge?.confidence).then(text => $.ui.toast(text, { timeoutMs: 6000 }))
    return (
      <Box flexDirection="row">
        <Text dimColor wrap="truncate-end">
          Compacted at a natural break ({unrated.judge}, {unrated.confidence.toFixed(2)}). Right call?{' '}
        </Text>
        <Button key="rate-good" label="👍 Yes" onPress={press(true)} />
        <Button key="rate-bad" label="👎 No, I was mid-task" onPress={press(false)} />
        <Button key="rate-dismiss" label="Dismiss" onPress={() => void update($, panel, s => ({ ...s, unrated: undefined }))} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const [s, now] = await Promise.all([read($, panel), $.clock.now()])
    const p = priceOf(s.model)
    const cols = e.props.bodyColumns
    const isWide = cols >= 70

    if (p === undefined || s.tokens === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Cost & cache</Text>
          <Text dimColor>Send a message: the panel fills in after the first reply.</Text>
        </Box>
      )
    }

    const cache = cacheState(s, now, ttlMsOf(ttl))
    const share = s.window > 0 ? s.tokens / s.window : 0
    const fill = meter(share, Math.max(10, Math.min(30, cols - 30)))
    const fillColor = share >= 0.8 ? 'error' : share >= 0.5 ? 'warning' : 'claude'
    const carry = (s.tokens * p.read) / 1e6
    const rebuild = (s.tokens * writePrice(p, ttl)) / 1e6
    const ratio = hitRatio(s)
    const list = hints(s, now, ttl).slice(0, 4)
    const last = s.turns.at(-1)
    const v = s.saved
    const perTurn = (v.removed * p.read) / 1e6
    const turnsLeft = payback(v, perTurn)
    const total = lifetime(v)
    const lv = level(total)
    const progress = meter(lv.next === undefined ? 1 : (total - lv.at) / (lv.next.usd - lv.at), Math.max(10, Math.min(30, cols - 30)))
    const hasSvg = 'Svg' in els && els.Svg !== undefined

    const tile = (label: string, value: string, key: string) => (
      <Box key={key} flexDirection="column" marginRight={3}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )

    const hintRow = (hint: Hint) => {
      const lv = LEVEL[hint.level]
      return (
        <Box key={`hint-${hint.id}`} flexDirection="column" marginTop={1}>
          <Text>
            <Text color={lv.color}>{lv.icon} {lv.word}</Text>
            <Text bold>  {hint.title}</Text>
            <Text dimColor>  ~{usd(hint.stake)} at stake</Text>
          </Text>
          <Text dimColor wrap="wrap">  {hint.detail}</Text>
          <Box flexDirection="row" marginLeft={2}>
            {hint.action === 'compact' && (
              <Button key={`compact-${hint.id}`} variant="primary" onPress={() => void compactAndLog($, ttl)}>
                Compact with handoff
              </Button>
            )}
            <Button
              key={`dismiss-${hint.id}`}
              onPress={() => void update($, panel, st => ({ ...st, dismissed: [...st.dismissed, hint.id] }))}
            >
              Dismiss
            </Button>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text bold>Cost & cache</Text>
          <Text dimColor>  {s.model} · {ttl} cache</Text>
        </Text>

        <Box marginTop={1}>
          {cache === undefined ? (
            <Text dimColor>○ Cache state unknown until the next reply</Text>
          ) : cache.isWarm ? (
            <Text>
              <Text color="success">● Warm</Text>
              <Text>  expires in {minutes(cache.remainingMs)}</Text>
              <Text dimColor>  · rebuilding later costs {usd(rebuild)}</Text>
            </Text>
          ) : (
            <Text>
              <Text color="warning">○ Cold</Text>
              <Text>  the next message re-writes {kTokens(s.tokens)}</Text>
              <Text dimColor>  · {usd(rebuild)}</Text>
            </Text>
          )}
        </Box>

        <Text>
          <Text dimColor>Context  </Text>
          <Text color={fillColor}>{fill.filled}</Text>
          <Text dimColor>{fill.track}</Text>
          <Text>  {kTokens(s.tokens)} / {kTokens(s.window)} ({Math.round(share * 100)}%)</Text>
        </Text>

        <Box flexDirection={isWide ? 'row' : 'column'} marginTop={1}>
          {tile('Session cost', usd(s.sessionUsd), 'tile-session')}
          {tile('Cache hit', ratio === undefined ? '–' : `${(ratio * 100).toFixed(1)}%`, 'tile-hit')}
          {tile('Re-read per turn', usd(carry), 'tile-carry')}
          {tile('Rebuild if cold', usd(rebuild), 'tile-rebuild')}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Saved by compacting</Text>
          {v.compactions === 0 ? (
            <Text dimColor>Nothing yet this session. Compact at a task boundary to start saving.</Text>
          ) : (
            <Text>
              <Text bold color={net(v) >= 0 ? 'success' : 'warning'}>{signed(net(v))}</Text>
              <Text> this session</Text>
              <Text dimColor>
                {'  '}· {v.compactions} compaction{v.compactions === 1 ? '' : 's'} · {kTokens(v.removed)} less to re-read, ~{usd(perTurn)} per turn
              </Text>
            </Text>
          )}
          {turnsLeft > 0 && <Text dimColor>  The compaction pays for itself in {turnsLeft} more turn{turnsLeft === 1 ? '' : 's'}.</Text>}
          <Text>
            <Text color="claude">★ Level {lv.rank}: {lv.name}</Text>
            <Text dimColor>  all time {signed(total)}</Text>
          </Text>
          {lv.next !== undefined && (
            <Text>
              <Text color="claude">{progress.filled}</Text>
              <Text dimColor>{progress.track}</Text>
              <Text dimColor>  {usd(lv.next.usd - total)} to {lv.next.name}</Text>
            </Text>
          )}
        </Box>

        {s.turns.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Cost per turn</Text>
            {hasSvg ? (
              <els.Svg source={costChart(s.turns)} alt={chartAlt(s.turns)} isInteractive />
            ) : (
              <Text color="claude">{sparkline(s.turns, Math.max(10, cols - 4))}</Text>
            )}
            {last !== undefined && (
              <Text dimColor wrap="wrap">
                Last turn: {SERIES.map(x => `${x.label.toLowerCase()} ${usd(last[x.key])}`).join(' · ')}
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hints</Text>
          {list.length === 0 ? (
            <Text>
              <Text color="success">✓ Nothing to act on.</Text>
              <Text dimColor>  The cache is doing its job.</Text>
            </Text>
          ) : (
            list.map(hintRow)
          )}
        </Box>
      </Box>
    )
  })
}
