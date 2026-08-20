# ADR-009: Subagent Output-Token Finalization via toolUseResult

## Decision

Superseded by ADR-013 for the current capture path (`SubagentStop` polling replaces this repair).
Recorded here for the technical fact it established, which remains relevant background:
a subagent's last transcript entry can persist in a non-finalized streaming state (`stop_reason: null`, `output_tokens` frozen at an early snapshot)
while `content` and `input`/`cache` fields are already correct — only `output_tokens` is stale, sometimes by orders of magnitude.

The original fix read the main transcript's `toolUseResult.usage` (finalized, but covering only the subagent's *final* API call)
and merged it into the `.jsonl`-derived aggregate (which sums *all* calls) — repairing only the last call's stale figure,
keeping full multi-step coverage from the transcript aggregate. The repair applied positionally (last message),
not by matching model name, because `toolUseResult.resolvedModel` and `message.model` use different naming.

## Why

- An authoritative source (`toolUseResult`) existed for the main-turn path, so estimating output tokens from content length was unnecessary and less accurate.
- This repair source does not exist for background subagents (see ADR-013), which is why the current design instead polls the subagent's own transcript for a finalized entry rather
  than repairing from `toolUseResult`.
