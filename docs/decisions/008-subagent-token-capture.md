# ADR-008: Subagent Token Aggregation via meta.json Matching

## Decision

Subagent transcripts live under an undocumented path structure with the same data format as the main transcript, including a full input/output/cache breakdown and model
attribution:

```
~/.claude/projects/<project>/<session-id>/subagents/
  agent-<agentId>.jsonl
  agent-<agentId>.meta.json
```

Each `meta.json` contains a `toolUseId` matching the `id` of the corresponding `tool_use` block in the main transcript, uniquely identifying which subagents belong to a given turn
with no state file or text parsing required. (Capture is now triggered from `SubagentStop`, not `Stop` — see ADR-013; this ADR covers the aggregation logic, which is still
current.)

**Token aggregation.** Subagents can make multiple internal API calls, each written to the transcript several times as streaming artifacts sharing one `message.id` (input/cache
fields constant, `output_tokens` growing until the final artifact). `aggregateUsage()` dedupes by `message.id` (last artifact wins) before summing per model — summing raw lines
would inflate input/cache totals by the number of streaming snapshots. If a subagent uses more than one model, a separate queue entry is produced per model. The same function is
applied to the main turn, since a multi-step tool-use turn also issues several billed calls under distinct `message.id`s.

## Why

- `total_tokens`-only accounting is insufficient for cost estimation since output tokens cost ~5x more than input tokens; the full breakdown is needed.
- Matching via the structured `toolUseId` in `meta.json` is more robust than parsing `agentId` out of unstructured tool_result text.

## Known limitations

- The `subagents/` path is not a public contract — if Claude Code changes it, subagent capture silently stops while main-turn capture is unaffected.
- Nested subagents (subagents that themselves launch Agent tool calls) are not captured.
- Filename collisions within the same millisecond in one process are resolved by a process-global counter appended to the filename (`{timestamp}-{pid}-{counter}.json`).
