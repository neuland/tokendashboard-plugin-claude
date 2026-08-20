# ADR-013: Capture Subagent Tokens from the SubagentStop Hook

## Decision

Subagent capture happens from a dedicated `SubagentStop` hook (`hook.js --subagent-stop`), not from `Stop`. Each subagent is captured once, at its own completion, from its own
finalized transcript (`agent_transcript_path` from the hook payload). `captureSubagent`:

1. Returns immediately if `agent_transcript_path` is missing or doesn't exist (drops spurious `agent_type: ""` firings).
2. Polls the transcript (`readFinalizedLines`, ~3s window) until the chronologically **last** countable assistant entry reaches a terminal `stop_reason`. On timeout it falls back
   to the fullest snapshot read rather than dropping the turn.
3. Runs the unchanged `aggregateUsage` (per-model dedup by `message.id`, including the advisor `iterations[]` walk from ADR-011) and writes one entry per model, keyed by the
   existing `entryId(session, model, ids)`.

`Stop` reverts to main-agent-only capture; the ADR-008 subagent loop and the ADR-009 `toolUseResult` repair are removed from `capture()`. `aggregateUsage` and `entryId` are
unchanged and shared by both entry points.

**Shared finalization predicate.** Both `capture()` (Stop) and `readFinalizedLines` (SubagentStop) judge "done" via `lastCountableAssistant` (backward scan for the last assistant
entry with `usage` + `model` + `message.id`) and `isTerminalStop` — an explicit allowlist (`TERMINAL_STOP_REASONS`: `end_turn`, `stop_sequence`, `max_tokens`, `refusal`,
`model_context_window_exceeded`), not a "truthy and not `tool_use`" denylist. Only the poll window (main ≈1s, subagent ≈3s) and the timeout fallback differ between the two paths.

## Why

- The Agent tool's default (`run_in_background: true`) means a subagent completes many turns after it launches — by the time `Stop` fires for the launch turn, the subagent's
  transcript is still empty, so the ADR-008 same-turn capture largely misses background subagents, and the ADR-009 `toolUseResult` repair source is likewise absent for them (only
  present on synchronous, same-turn completions).
- `SubagentStop` is the only hook that reliably fires for both background and synchronous Agent-tool completion; `TaskCompleted` does not fire for background subagents.
- An allowlist for "terminal" is required, not a `!== null`/not-`tool_use` denylist: a `pause_turn` (emitted mid-turn for server-side tools, resumed afterward) or a finalized
  `tool_use` (the true final call not yet appended) would wrongly look terminal under a denylist and truncate the aggregate before the subagent's largest call lands.
- "Last entry finalized," not "any trailing finalized" — a multi-step subagent's earlier calls can finalize while its largest, final call is still a stale streaming snapshot;
  returning early on any finalized entry undercounts badly.
- The two paths sharing one finalization predicate prevents them from silently diverging on what "done" means; only the poll window and fallback are allowed to differ.
- Idempotency: re-firing `SubagentStop` for the same completed subagent reads the same finalized transcript, the same `message.id` set, and therefore the same `entryId` — the
  endpoint dedupes for free, with no marker state needed.

## Alternatives considered

- **Keep capture in `Stop`, scan the whole `subagents/` dir each turn with a write-once marker**: works, but adds persistent marker state, per-turn full-directory I/O, and keeps
  the retired ADR-009 plumbing — strictly more complex than SubagentStop's once-per-subagent semantics.
- **`TaskCompleted`**: does not fire for background Agent-tool subagents.
- **Keep both `Stop`- and `SubagentStop`-path capture**: the `Stop` path would still write a near-zero entry from an empty transcript, with a different `message.id` set and thus a
  different `entryId` — reintroducing double-counting instead of deduping. Replacement is required.

## Known limitations

- If a subagent's transcript never finalizes within the poll window, its `output_tokens` stay stale with no repair available (a mild regression only versus the synchronous case
  that had the ADR-009 repair; background subagents never had it, so for them this is a net improvement).
- A subagent still running at session end is not captured that session — inherent to store-and-forward.
- `agent_transcript_path` is an undocumented payload field; if it changes, subagent capture degrades gracefully (existence guard → skip) without affecting main-turn capture.
- Nested subagents remain uncaptured.
- A re-fire before the subagent emits further billed messages could double-count (different message-id sets hash to different `entryId`s); requires a re-fire strictly before
  completion, treated as not occurring in practice.
