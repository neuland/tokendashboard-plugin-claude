# ADR-012: Fetched-Fresh Updater, Relocation, and Auto-Settings-Write

## Decision

`hook.js` contains only `capture`/`flush` and a minimal loader. On `--check-update`, the loader
fetches `updater.js` fresh from the repo and runs it via `node -` (stdin) — `updater.js` is never
written to disk. `updater.js`'s `converge()` downloads any changed `pluginFiles`, relocates the
hook under `~/.claude/token-usage-plugin/`, and repoints `settings.json` only on drift.

## Why

- Fetching the updater fresh keeps the permanently-frozen surface (the loader) tiny, so an
  update-logic bug is fixed server-side and self-heals on the next session.
- Piping to `node -` via stdin writes nothing to disk (works under a `noexec` mount, avoids a
  world-writable `/tmp`, works cross-platform).
- `capture`/`flush` must stay in `hook.js`, not the fetched updater — otherwise telemetry stops
  working whenever the update source is unreachable.
- `converge` writes `settings.json` only on drift (never unconditionally): the file is shared
  with Claude Code, and an unconditional rewrite risks clobbering a concurrent write with no way
  to lock against it. The drift check must stay scoped (only our own hook entries) and
  environment-stable (the same `$HOME`-relative string in host and devcontainer), or steady state
  stops being zero writes and the two environments ping-pong `settings.json`.
- A dedicated update lock (separate from the flush lock) prevents concurrent sessions from all
  fetching/installing at once, and lets `converge` hold the lock across a slow network fetch
  without blocking a same-session flush. Same stale-steal protocol as the flush lock (ADR-004); a
  NaN/empty pid must be treated as stealable, or a zero-byte lock (crash between create and
  pid-write) blocks updates forever.
- Payload downloads are per-file atomic (tmp+rename), not set-atomic; `currentVersion` bumps only
  after every file lands, so a concurrent reader never observes a half-updated set.
- The legacy pre-relocation file is removed only on explicit `uninstall`, never automatically — a
  parallel session may still be bound to it.
- Migration runs from `--check-update`, not from `converge`, because that is the first new code to
  execute after an old, frozen updater on an existing install delivers the new `hook.js` — updates
  are not sequential (a fetch always pulls the latest `main`), so the new `hook.js` must be a
  competent migrator from any older version, not just the immediately preceding one. The loader
  forces an immediate update when running from a non-canonical path, so relocation doesn't wait
  for the 24h throttle — bounded by a `migrationBlocked` flag when the remote is genuinely older,
  so a rolled-back release doesn't cause a per-session fetch storm.
- `uninstall` clears `currentVersion` first, and `converge` re-reads it after every network
  round-trip — this closes most of the window where an in-flight `converge` could resurrect files
  an `uninstall` just removed; the two are otherwise unsynchronized by design (blocking `uninstall`
  on a network-holding `converge` would be worse).
- Fetched `.js` payloads are validated by compiling them with `vm.Script` (no execution) before
  they're staged or `currentVersion` bumps — a 200 response is not proof the body is genuine
  source (a proxy/CDN/SSO gate can return a login page with HTTP 200), and writing such a body as
  `hook.js` would permanently wedge telemetry. This check is deliberately **not** applied to the
  `updater.js` fetch itself: a junk `updater.js` run via `node -` writes nothing and self-heals
  next session, and the loader stays minimal on purpose.
- `updater.js` is the `npx` `bin` entry directly; there is no separate `cli.js` delegator — both
  ship in the same npx package at the same version, so a delegator would be pure duplication.
