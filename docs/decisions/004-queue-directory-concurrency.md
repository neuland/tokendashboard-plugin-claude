# ADR-004: Queue Directory over Single Queue File (Concurrency Safety)

## Decision

The queue is a directory with one file per entry, not a single JSON file:

```
~/.claude/token-usage-plugin/queue/
  1749123456789-42-0.json    ← [timestamp]-[pid]-[counter].json
  1749123456789-42-1.json
```

Flush coordination uses a lock file at `~/.claude/token-usage-plugin/queue/.lock`.

## Why

- Multiple `Stop` hooks can run concurrently (e.g. parallel tool calls within a turn), and a `SessionEnd` flush may be running at the same time — a single file needs
  read-modify-write cycles that lose data under concurrent writers, and JSON append is not atomic on most filesystems.
- **Writing**: each hook writes a uniquely-named file (`Date.now()-pid-counter`); file creation is atomic, so no two processes collide. The in-process counter is required because
  one hook invocation can write multiple entries (main turn + per-subagent) within the same millisecond. Each entry is written to `.tmp` then `fs.renameSync`'d to its final name —
  this closes a partial-read window where a concurrent flush in another process could list a mid-write `.json` file, fail to parse it, and drop it. `.tmp` files never end in
  `.json`, so `getQueueFiles()` ignores in-progress writes.
- **Flushing**: the lock file is created with `O_CREAT | O_EXCL`, an atomic OS operation — a second flush process gets `EEXIST` and exits immediately.
- **New entries during an active flush**: flush snapshots existing files at startup and only processes those; files written after the snapshot are picked up by the next flush.
- The lock must always be released in a `finally` block; a stale lock (owning process dead) is automatically stolen on next acquire.
- The queue directory must not be deleted while entries are pending — they would be lost.
