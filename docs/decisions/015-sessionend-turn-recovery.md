# ADR-015: Recover Interrupted-Turn Tokens at SessionEnd

## Decision

At `SessionEnd`, before flushing, `catchUpCapture` re-aggregates the transcript's trailing turns (bounded to `CATCH_UP_MAX_TURNS` = 10) and (re-)writes a queue entry for each,
relying on the existing `entryId(sessionId, model, ids)` dedup hash to make re-emitted, already-captured turns safe no-ops server-side — no new local "what have I captured" state
is introduced.

- `isTurnOriginEntry` (shared verbatim with `capture()`'s own turn-origin scan) and `findTurnOrigins` locate turn boundaries; both are shared so "where does a turn start" can never
  drift between the normal and catch-up paths — a drift would shift the id set for an already-captured turn and defeat dedup.
- Only the last `CATCH_UP_MAX_TURNS` turns are re-scanned: earlier turns were already captured and flushed in prior sessions.
- `main()`'s `--flush` branch now reads stdin and runs `catchUpCapture` in its own `try`/`catch` before calling `flush()`, so a catch-up failure can never block the flush itself.

## Why

- `Stop` fires only on a genuine, successful turn completion — never on a user interrupt (Escape) or a denied tool permission (`PermissionDenied`, unregistered). An aborted turn's
  tokens never reach `capture()` at all; if it's the session's last turn, they'd otherwise be lost permanently.
- Dedup safety follows from transcript structure: a turn N already captured by a normal `Stop` had window `[originN, endOfFileAtStopTime)`; nothing is appended between turn N's
  last entry and turn N+1's origin, so catch-up's `[originN, originN+1)` segment for that same turn produces an identical message-id set and therefore an identical `entryId`.
- Bounding to trailing turns (rather than an unbounded rescan) keeps the common case — nothing to recover — cheap; `SessionEnd` fires more often than `/exit` (also on `/clear` and
  compaction).

## Alternatives considered

- **Persist a "last captured position" marker per session**: adds new local state and a new failure surface (race with concurrent `Stop` writes, staleness on crash) for no benefit
  over dedup that's already trusted elsewhere in this codebase.
- **Unbounded re-scan every `SessionEnd`**: correct via dedup but wastes local writes and network egress resending a long session's full history repeatedly.

## Known limitations

- Pre-existing, not introduced here: `capture()`'s own turn-window scan could, in a narrow race (interrupt immediately followed by a re-prompt before the transcript settles), pick
  a slightly different boundary than catch-up's clean segmentation for the same turn — causing a double-count rather than a loss in that edge case.
