# ADR-019: Local History Node Requirement and Worktree-Aware Attribution

## Decision

Local history (`local.sqlite`) and `report.js` need `node:sqlite`, available from Node 22.13. `package.json`'s `engines.node` is `">=22.13"`.

- `install` checks the running Node and prints a note below the minimum, but never blocks or changes what gets installed — install/update copy the plugin's files
  unconditionally, regardless of Node version. Whether `node:sqlite` actually works is a pure runtime check, re-evaluated fresh every time a hook process runs, independent of
  which Node version was used to install or update. The note tells the user local history/report need Node 22.13+ in whichever terminal Claude Code actually runs in — not to
  reinstall.
- Everything else (queue sync, statusline, price fetch) has no `node:sqlite` dependency and is unaffected by the Node version.
- `writeLocalHistory` logs `"Node 22.13+ needed for local history (node:sqlite unavailable in <ver>)"` to `error.log` when `node:sqlite` is missing, instead of the raw
  `ERR_UNKNOWN_BUILTIN_MODULE` exception.
- `statusline.js` shows a red `⚠ local storage off (Node <ver> < 22.13)` segment only when local history has previously produced data (`local.sqlite` exists) AND `node:sqlite`
  is currently unavailable. An install that has never produced local-history data stays silent.

`detectProject(cwd)`/`detectBranch(cwd)` resolve `cwd` through `resolveBaseWorktree(cwd)` first: a `git worktree list --porcelain` call whose first line is always the
repository's original ("main") worktree, regardless of which worktree the command runs from. Project and branch are derived from that base worktree, not from `cwd` directly.

## Why

- Local history/report are additive; failing the whole install over one optional feature would take away the queue/backend telemetry path too.
- Reinstalling under a different Node does not change runtime availability — the check runs fresh per hook execution — so the install-time message must not suggest it does.
- A named requirement and the actual running version in `error.log` is more actionable than a raw `ERR_UNKNOWN_BUILTIN_MODULE`.
- The statusline only warns on a below-minimum Node when `local.sqlite` already exists: that user relies on local history and expects the current session's tokens to be
  tracked. A user who has never used the feature does not rely on it and needs no warning.
- An isolated `git worktree` (e.g. an agent-per-worktree workflow) has its own transient folder name and branch, meaningless for reporting; resolving through the original
  worktree attributes history to the project the agent actually started from. For a plain, non-worktree repo, resolution is a no-op.

## Alternatives considered

- **Hard-failing `install` below the minimum Node version**: rejected — would take the whole plugin down over one optional feature.
- **An install-time `config.json` flag for "local history should be active"**: rejected — would never retroactively appear for already-installed users, since auto-update never
  re-runs `install()`.
