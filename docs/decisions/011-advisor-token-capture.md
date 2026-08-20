# ADR-011: Advisor Token Capture via usage.iterations

## Decision

The `/advisor` feature runs server-side, inside a single executor API call — not a separate session. The advisor's tokens are billed to its own model but live only in
`message.usage.iterations[]`, as entries with `type: "advisor_message"` and their own `model`; the flat top-level `message.usage` totals cover only the executor and exclude the
advisor by construction.

`aggregateUsage` walks `message.usage.iterations[]` for each deduped `message.id` and, for every `advisor_message` entry with a `model`, attributes its usage to that model via the
shared accumulator — in addition to the existing flat-totals handling for the executor.

## Why

- Reading only the flat `message.usage` silently drops the advisor entirely; in observed sessions the advisor's usage can dwarf the executor's, so this is not a negligible gap.
- Iterations are read from the same by-`message.id` deduped entry as the flat totals, so streaming artifacts sharing an id count the advisor once, not once per snapshot.
- Iterations must be read from the transcript entry's own `usage`, not the ADR-009 `finalizedUsage` repair value, which is a flat figure with no `iterations`.
- The advisor accumulator's `ids` list holds the parent `message.id`; `entryId` namespaces by model, so advisor and executor entries derived from the same message never collide —
  even when they share a model (in which case both correctly fold into one accumulator).
- Entries without a `model` are skipped rather than mis-booked onto the executor.

## Alternatives considered

- **Sum `iterations` as the sole source of truth**: the flat totals already dedupe cleanly and are the documented executor figure; only the advisor sub-call is missing, so a
  targeted extraction is the minimal correct fix.
- **Detect the advisor via `server_tool_use`/`advisor_tool_result` blocks**: those confirm the advisor ran but carry no token figures.
- **Key by the `advisorModel` field**: present whenever the advisor is enabled, regardless of whether it was actually consulted in that entry — not a reliable per-call signal.
