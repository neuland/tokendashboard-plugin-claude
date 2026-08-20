# ADR-003: Stop Hook for Capture, SessionEnd Hook for Flush

## Decision

- **`Stop`** — capture: read token data from the transcript, write it to the queue.
- **`SessionEnd`** — flush: send the queue to the API endpoint.

## Why

- Capture and flush have different performance characteristics: capture is per-turn and local, flush is network-dependent. Splitting them onto different events avoids a network
  round-trip on every turn.
- Flushing on every `Stop` would mean one HTTP attempt per turn (e.g. 20 per session); with the network unreachable that's a noticeable delay each time.
- `PreCompact` fires too rarely (~80% context fill) to be a reliable flush trigger.
- `SessionEnd` alone can't replace `Stop` — it doesn't provide transcript access, so token data would never be captured.

## Known limitations

- `Stop` does not fire on user interrupts (Ctrl+C mid-generation) — the in-progress turn is not captured directly (recovered at `SessionEnd`, see ADR-015).
- `SessionEnd` does not fire on SIGKILL — the final flush is lost, but queued entries persist and are sent at the next session.
