# Architecture

## Plugin decision flow (`smart-compactor`)

```mermaid
flowchart TD
    A["Bash tool call succeeds"] --> B{"matches an enabled<br/>signal? (git / deploy / ...)"}
    B -- no --> Z["nothing"]
    B -- yes --> C["remember boundary"]
    C --> D["turn completes<br/>with an answer"]
    D --> E{"mode = off, or<br/>context below minTokens?"}
    E -- yes --> Z
    E -- no --> F{"mode"}
    F -- suggest --> G["toast + status line +<br/>suggest /smart-compact"]
    F -- auto --> H["wait 1.5 s, then compact<br/>with a handoff summary"]
    G --> I["user runs /smart-compact"] --> H
```

The cost & cache panel (`/cost-panel`) runs alongside: it records the cost of each turn,
counts down to cache expiry, and ranks hints (task boundary, cache expiring or cold,
unexpected cache rebuild, large context, cheaper model, large tool output).

The flow above is `suggest` mode, and `auto` mode with `judge=off`.

## Prompt-time judge

In `auto` mode a judge model decides when you send your next prompt.

```mermaid
flowchart TD
    A["you send a prompt<br/>(no image, no @-mention)"] --> B{"context ≥ minTokens?"}
    B -- no --> Z["the prompt runs"]
    B -- yes --> C["Sonnet reads the digest, plus<br/>your newest rated examples"]
    C --> D{"break, with confidence ≥<br/>the learned bar?"}
    D -- no --> Z
    D -- yes --> E["hold the prompt back"]
    E --> F["compact with a handoff summary<br/>that names the new prompt"]
    F --> G["send the prompt again"] --> H["band: 👍 / 👎"]
    H --> I["rating stored: the bar moves,<br/>the example joins the prompt"]
    I -.-> C
```
