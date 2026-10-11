# smart-compactor

A Claude Code plugin that shows what your session costs and compacts it at task boundaries,
with a summary written as a handoff for the next task.

## What it does

- **Cost & cache panel** (`/cost-panel`): cost per turn, a countdown to prompt-cache expiry,
  and ranked hints: task boundary, cache expiring or cold, unexpected cache rebuild, large
  context, a cheaper model, large tool output. In the CLI it is a window with **Compact** and
  **Dismiss** buttons. The VS Code extension draws no plugin window, so there the command
  replies with the same report as text.
- **Compaction at natural breaks** (`auto` mode): when you send a prompt and the context is
  at least `minTokens`, a judge model (Claude Sonnet by default) reads a short digest of the
  session and the new prompt. If it sees a natural break with enough confidence, the plugin
  holds the prompt back, compacts with a handoff summary that also names the new prompt, and
  then sends it. The prompt you see in the transcript is then sent by the plugin. A prompt
  with an image or an `@`-mention is never held back, because a plugin can't send those again.
  Neither is a prompt from an SDK host (the VS Code extension, `claude -p`), where a held-back
  prompt would be lost. There the git signals decide, as with `judge=off`.
- **Compaction before the cache expires** (`auto` mode with a judge): after a turn with a
  git commit, push or PR on a large context, if no prompt follows, the plugin compacts 5
  minutes before the 1-hour cache expires (1 minute before the 5-minute one). The summarizer
  still reads the context from cache, and when you come back your next message re-writes the
  short summary instead of the whole context. A prompt sent before then cancels it, and the
  judge decides as usual. This only runs while Claude Code stays open.
- **Paused work is left alone**: if your last three prompts, or the answers since, say work is
  paused, on hold, blocked or waiting ("paused after step 3, resume once replica lag drops"),
  a git signal does not compact automatically. The plugin logs why; run `/smart-compact` if
  it is safe. The judge still decides at your next prompt.
- **👍 / 👎 on each automatic compaction**: a band above the prompt asks whether it was a
  natural break (or run `/smart-compact-rate up|down`). The judge learns from the answers:
  - each 👎 in your last 20 ratings raises the confidence it needs by 0.05, and each 👍
    lowers it by 0.02, never below where it started or above 0.9;
  - your newest three 👍 and three 👎 from the same project go into the judge's prompt as
    examples of where your work really ends.

  Ratings are kept in the plugin's store under `~/.claude`, with the digest the judge read
  (the start of your prompts and of the agent's answer, and file names) and the project's
  root. Ratings from every project move the confidence bar, but a digest is only shown to the
  judge in the project it was rated in, so prompts from one project never reach another's.
- **Task-boundary suggestions** (`suggest` mode): after a successful `git commit`, `git push`
  or `gh pr create/merge` command (more categories via `signals`), once the turn ends and the
  context is at least `minTokens`, it suggests `/smart-compact`. With `judge=off`, `auto` mode
  compacts on these signals instead.
- **`/smart-compact`**: compact now, with instructions to keep open work, paused work and
  why it stopped, decisions with their reasons, and file paths.
- **Saved by compacting**: what your compactions have saved, in the panel and in
  `/cost-panel`'s text. Each turn after a compaction is credited with the context it no
  longer re-reads; the compaction's own cost (the summarizer, and writing the new context to
  the cache) is taken off first, so a fresh compaction shows a small loss until it pays back.
  A compaction after the cache expired is priced against the full re-write the next turn
  would have needed anyway: it isn't charged for writing the new context, and the next turn
  is credited with the re-write it avoided.
  Your `/compact` counts; autocompact doesn't, since it would have run anyway. An all-time
  total across sessions earns levels, from Cache Rookie ($0) to Compaction Legend ($500),
  with a toast when you reach one. The total is kept in the plugin's own store under
  `~/.claude`: dollar amounts and counts only, one entry per session.

See [the decision flow](../../diagrams/architecture.md#plugin-decision-flow-smart-compactor).

## Install

Requires Claude Code 2.1.295 or later, in the CLI or the VS Code extension. The extension
ships its own Claude Code, so update it from the Extensions view; Homebrew updates only the
CLI. See the [top-level README](../../README.md#install) for both.

```bash
claude plugin install smart-compactor --marketplace Eslamanwar/smart-compactor
```

The CLI and the VS Code extension read the same `~/.claude/settings.json`, so one install
enables the plugin in both. What differs between them is listed in
[CLI and VS Code](../../README.md#cli-and-vs-code).

Or, from a local clone, load it for one shell:

```bash
export CLAUDE_CODE_PLUGIN_DIRS="/path/to/smart-compactor/plugin/smart-compactor"
claude
```

## Settings

Pass them at install time (`--config mode=suggest --config minTokens=100000`), set them with
`/plugin configure smart-compactor@smart-compactor`, or edit `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "smart-compactor@smart-compactor": {
      "options": { "mode": "suggest", "minTokens": 100000 }
    }
  }
}
```

When the plugin is loaded from a local folder with `CLAUDE_CODE_PLUGIN_DIRS`, the key is the
bare name, `smart-compactor`, rather than `smart-compactor@smart-compactor`. Start a new
session after changing settings.

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `suggest`: notify only; `auto`: compact at a natural break; `off`: do nothing |
| `judge` | `sonnet` | who decides in `auto` mode: `sonnet` (starts at confidence 0.5), `haiku` (starts at 0.8, cheaper, compacts less often), or `off` (the `signals` decide) |
| `minTokens` | `150000` | act only when the context is at least this large |
| `cacheTtl` | `1h` | your main conversation's cache TTL (`5m` or `1h`) |
| `openPanel` | `true` | open the panel when a session starts (CLI only; VS Code draws no window) |
| `signals` | `git` | `git`, `git+deploy`, or `all` (adds tests, validate, build, finished todo lists) |

The defaults come from a replay study of past sessions:
no signal category marked a natural break more often than chance (7–17% vs a 14% base
rate), so wider signal sets mostly add compactions in the middle of a task. Use `suggest`
mode if you widen them. The Sonnet judge is the study's reference labeler: compacting where
it saw a break saved about 33% in the replay, and its starting confidence of 0.5 is the
reference's cut. Each check costs under a cent and waits up to 15 s before the prompt
goes on unjudged. The judge's cost is subtracted from **Saved by compacting**.

## Develop

```bash
claude plugin validate plugin/smart-compactor
claude plugin test plugin/smart-compactor
```

`.claude-plugin/types/` is generated by the Claude Code plugin tooling and is not committed;
`tsconfig.json` extends it.
