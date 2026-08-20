# ADR-005: Store-and-Forward to HTTP Endpoint over Local JSON File

## Decision

Entries are written locally to a queue immediately, and sent as a batch via HTTP POST to an internal endpoint at session end. If the endpoint is unreachable, entries remain queued
and are retried at the next session end.

```
Stop hook       → write to queue (always, immediately)
SessionEnd hook → flush queue (only if endpoint reachable)
```

The endpoint URL and timeout are constants in `hook.js`; the endpoint must be manually updated and reinstalled if it changes (see ADR-016 for the configurable base-URL variant).

## Why

- Token data needs central, company-wide analysis; employees aren't always on VPN — a local-only file would leave data scattered with no way to aggregate it.
- A direct HTTP request from the `Stop` hook would add a network timeout to every turn when off-VPN.
- Claude Code's native `type: "http"` hook has no local queuing on failure — every failed request would be lost, unsuitable for a VPN-optional environment.
- **Batching**: entries are sent oldest-first in batches (`FLUSH_BATCH_SIZE` = 500) so a long offline backlog never becomes one oversized POST the endpoint rejects.
- **Poison-pill drop**: a `4xx` (other than the transient codes below) means the server will never accept that payload, so the batch is discarded instead of blocking every later
  batch with infinite retries. `5xx`/network errors are transient — the batch is kept and flushing stops until next session.
- **Reachability codes are transient, not rejections**: `401`/`403`/`408`/`429` are exempted from the poison-pill drop. `401`/`403` specifically can mean the request reached a
  public nginx (not the real backend) because the hostname resolves publicly but answers 403 without VPN — treating that as a content rejection would silently wipe the queue on
  every off-VPN flush.
- **Age cap**: entries older than `MAX_QUEUE_AGE_MS` (30 days) are pruned before sending, bounding disk usage if the endpoint is permanently unreachable.

## Consequences

- The 30s timeout at `SessionEnd` is acceptable since the session is already ending, but an unreachable endpoint can noticeably delay session exit before the batch is requeued.
- Entries are lost only on SIGKILL (the queue persists and is retried next session), on a permanent `4xx` rejection, or past the 30-day age cap — the latter two are logged to
  `error.log`.
