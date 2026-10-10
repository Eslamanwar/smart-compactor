export type TurnRow = {
  /** When the turn ended, in $.clock.now() milliseconds. */
  at: number
  model: string
  /** Context the turn's last request was answered over, in tokens. */
  ctx: number
  readTokens: number
  writeTokens: number
  /** USD by part, as the chart stacks it. */
  read: number
  write: number
  output: number
  input: number
}

/** What compacting has saved in this run of the session, in USD and tokens. */
export type Savings = {
  /** Re-reads avoided: each turn since a compaction, priced at what it no longer carries. */
  gross: number
  /** What the compactions cost: the summarizer, and writing the new context to the cache. */
  spent: number
  /** Tokens the compactions took out of the context, summed. */
  removed: number
  compactions: number
  /**
   * The next turn re-writes the cache after a warm compaction; it is not a rebuild to credit.
   * After a cold one it is: without the compaction, the old context would have been re-written.
   */
  isFresh: boolean
  /** Net USD saved by earlier runs, from the plugin's store. */
  pastUsd: number
  pastCompactions: number
  /** This run's key in the store, kept here so a hot reload writes the same entry. */
  runKey?: string
}

/** What the break judge reads at a new prompt: the task-boundary study's digest. */
export type Digest = {
  /** The task's first prompt, or the session's since the last compaction. */
  taskStart: string
  /** The two prompts before the new one. */
  previous: string[]
  /** Files edited since the previous prompt, by name. */
  files: string[]
  /** The start of the agent's last answer. */
  lastAnswer: string
  newPrompt: string
}

/** The person's 👍 or 👎 on an automatic compaction, one store entry each. */
export type Rating = {
  at: number
  isGood: boolean
  confidence: number
  digest: Digest
  /** The project root it was rated in: its digest is an example for that project's judge alone. */
  project?: string
}

/** An automatic compaction the person has not rated yet; the band above the prompt asks. */
export type Unrated = {
  at: number
  judge: string
  confidence: number
  threshold: number
  digest: Digest
  project: string
}

export type PanelState = {
  turns: TurnRow[]
  /** Last main-conversation request, which refreshed the cache's TTL. */
  lastActivityAt?: number
  /** A task boundary seen in the last turn and not compacted yet. */
  boundary?: 'pr' | 'push' | 'deploy' | 'commit' | 'tests' | 'validate' | 'build' | 'todos'
  /** The latest large tool output, still in context. */
  bigOutput?: { tool: string; tokens: number }
  dismissed: string[]
  /** Bumped on a timer so the countdown redraws. */
  tick: number
  tokens: number
  window: number
  sessionUsd: number
  model: string
  saved: Savings
  unrated?: Unrated
}

declare module 'claude-code' {
  interface PluginState {
    'smart-compactor': { panel: PanelState }
  }
}
