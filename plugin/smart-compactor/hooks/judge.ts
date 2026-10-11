import type { SessionMessage } from 'claude-code'

import type { Digest, Rating } from '../types'

// The judge's question and digest are the ones an offline task-boundary replay study used,
// so the plugin asks what the study measured.
export const SYSTEM = `You label moments in a developer's session with an AI coding agent.
You see what the session has been about and the developer's NEW prompt.
Decide whether this is a NATURAL BREAK: the previous piece of work is finished, and the new
prompt could be handled well if the earlier conversation were replaced by a short handoff
summary (what was done, decisions, open items, file paths). Answer false when the new prompt
depends on exact details from the recent conversation (error output, a specific line just
discussed, an answer it is replying to, an in-progress debugging thread).
Judge only from what is shown. Reply with one JSON object only:
{"break": true|false, "confidence": <0.0-1.0>}`

export type Judge = 'sonnet' | 'haiku'

export const JUDGES: Record<Judge, { model: string; priceAs: string; confidence: number }> = {
  // Sonnet at the study's reference cut; Haiku at its pre-registered one.
  sonnet: { model: 'sonnet', priceAs: 'claude-sonnet-5-5', confidence: 0.5 },
  haiku: { model: 'haiku', priceAs: 'claude-haiku-5-5', confidence: 0.8 },
}

// Learning: each 👎 in the last RECENT ratings raises the bar, each 👍 takes some of that back.
const RECENT = 20
const BAD_RAISES = 0.05
const GOOD_LOWERS = 0.02
const CEILING = 0.9
const EXAMPLES_EACH = 3

const TAG = /<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g
const SUMMARY = /^This session is being continued from a previous conversation/
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const clean = (text: string) => text.replace(TAG, '').trim()

/** The digest of the session at a new prompt, or undefined before the session's second prompt. */
export const digest = (messages: readonly SessionMessage[], newPrompt: string): Digest | undefined => {
  const prompts: string[] = []
  let taskStart: string | undefined
  let files: string[] = []
  let lastAnswer = ''
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const t of m.toolUses) {
        const path = t.input.file_path ?? t.input.notebook_path ?? t.input.path
        if (EDITS.has(t.tool) && typeof path === 'string') files.push(path.split('/').at(-1) ?? path)
      }
      if (m.text.trim() !== '') lastAnswer = m.text.trim()
      continue
    }
    if (m.toolResults?.length) continue
    const text = clean(m.text)
    // Command rows and notices are tagged; a compaction's summary starts the task over.
    if (text === '' || text.startsWith('<')) continue
    if (SUMMARY.test(text)) {
      taskStart = undefined
      continue
    }
    prompts.push(text)
    taskStart ??= text
    files = []
    lastAnswer = ''
  }
  if (prompts.length === 0) return undefined
  return {
    taskStart: (taskStart ?? prompts[0]!).slice(0, 400),
    previous: prompts.slice(-2).map(p => p.slice(0, 300)),
    files: [...new Set(files)].slice(-8),
    lastAnswer: lastAnswer.slice(0, 300),
    newPrompt: clean(newPrompt).slice(0, 500),
  }
}

// Words for work stopped on purpose: a paused migration, a rollout waiting on someone.
const HOLD = /\b(paus(e|ed|es|ing)|on hold|hold off|halt(ed)?|blocked (on|by)|waiting (for|on)|wait (for|until)|(don'?t|do not) (continue|proceed|resume|run)|resume (once|when|after|later)|stopp?(ed)? (here|before|partway|halfway))\b/i
const HOLD_PROMPTS = 3

/**
 * Whether the last few prompts, or the answers since, say work is paused or blocked. A
 * summary could drop why it stopped, so a compaction there is the person's call.
 */
export const isOnHold = (messages: readonly SessionMessage[]) => {
  let prompts = 0
  for (let i = messages.length - 1; i >= 0 && prompts < HOLD_PROMPTS; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.toolResults?.length) continue
    const text = clean(m.text)
    if (m.role === 'user') {
      if (text === '' || text.startsWith('<')) continue
      if (SUMMARY.test(text)) break
      prompts++
    }
    if (HOLD.test(text)) return true
  }
  return false
}

const itemText = (d: Digest) =>
  [
    `Session started with: ${d.taskStart}`,
    'Recent prompts:',
    ...d.previous.map(p => `- ${p}`),
    `Files edited since the last prompt: ${d.files.join(', ') || 'none'}`,
    `Agent's last answer began: ${d.lastAnswer}`,
    `NEW prompt: ${d.newPrompt}`,
  ].join('\n')

/** The newest ratings of each kind, oldest first: what the judge learns this developer's breaks from. */
export const examples = (ratings: readonly Rating[]) => {
  const newest = [...ratings].sort((a, b) => b.at - a.at)
  const pick = (isGood: boolean) => newest.filter(r => r.isGood === isGood).slice(0, EXAMPLES_EACH)
  return [...pick(true), ...pick(false)].sort((a, b) => a.at - b.at)
}

export const prompt = (d: Digest, rated: readonly Rating[]) => {
  const past = rated.map(r =>
    `<rated verdict="${r.isGood ? 'right: a natural break' : 'wrong: the work was still going'}">\n${itemText(r.digest)}\n</rated>`,
  )
  const lead = past.length === 0
    ? []
    : ['This developer rated earlier moments where a compaction ran. Learn from them where their work really ends:', ...past, '']
  return [...lead, `<item>\n${itemText(d)}\n</item>`].join('\n')
}

/** The judge's reply as a verdict, or undefined when it is not the JSON asked for. */
export const verdict = (text: string): { isBreak: boolean; confidence: number } | undefined => {
  const json = /\{[\s\S]*?\}/.exec(text)?.[0]
  if (json === undefined) return undefined
  try {
    const v = JSON.parse(json) as { break?: unknown; confidence?: unknown }
    if (typeof v.break !== 'boolean' || typeof v.confidence !== 'number') return undefined
    return { isBreak: v.break, confidence: v.confidence }
  } catch {
    return undefined
  }
}

/** The confidence a break needs, from where the judge starts and how its compactions were rated. */
export const threshold = (start: number, ratings: readonly Rating[]) => {
  const recent = [...ratings].sort((a, b) => b.at - a.at).slice(0, RECENT)
  const bad = recent.filter(r => !r.isGood).length
  const good = recent.length - bad
  const t = Math.min(CEILING, start + Math.max(0, BAD_RAISES * bad - GOOD_LOWERS * good))
  return Math.round(t * 100) / 100
}
