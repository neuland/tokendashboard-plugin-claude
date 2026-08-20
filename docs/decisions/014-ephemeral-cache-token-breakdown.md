# ADR-014: Transmit Cache-Write Tokens Broken Down by TTL

## Decision

Two fields, `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, are added to the aggregated `usage` object as flat siblings of `cache_creation_input_tokens`,
`cache_read_input_tokens`, `input_tokens`, and `output_tokens`. Both are summed inside `aggregateUsage`'s shared `accFor`/`addUsage` pair, so every capture path (`Stop`,
`SubagentStop`, advisor `iterations[]`) picks them up automatically with no path-specific code. Each defaults to `0` (via optional-chaining + `?? 0`) when a call's
`usage.cache_creation` breakdown is absent or partial.

## Why

- Anthropic bills 5-minute and 1-hour ephemeral cache writes at different rates; a single combined `cache_creation_input_tokens` total can't be split back into the true blended
  cost without assuming a fixed mix, which doesn't hold in practice.
- Flat siblings, not a nested `cache_creation` sub-object, keep the transmitted entry internally consistent — every other usage field is already flat.
- No client-side heuristic can recover the true 5m/1h split; only the API-reported breakdown is trustworthy.
- The breakdown is absent on many legitimate calls (no cache write occurred, or an older response predates it); defaulting to 0 rather than dropping/erroring on absence preserves
  the plugin's "never lose an entry" guarantee.
- These are token counts only, no new content or identity — no privacy/pseudonymization impact (see ADR-006).

## Consequences

- The ingest endpoint must tolerate the two additional keys (additive schema change, not enforced by the plugin).
- Entries already queued before an upgrade lack the two fields and are sent unchanged; the endpoint must tolerate their absence on older entries.
