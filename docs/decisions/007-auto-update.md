# ADR-007: Automatic Self-Update via SessionStart Hook

## Decision

A `SessionStart` hook (`--check-update`) checks for updates once every 24 hours and applies them silently in the background, in two stages:

1. **`--check-update`** (synchronous, <10ms): always spawns a detached background flush; reads `config.json`'s last update timestamp; if less than 24h have passed, exits; otherwise
   spawns the update step as a detached background process.
2. **Update step** (detached, async): probes for a newer version and applies it if found. What exactly gets fetched and how it's applied is described in ADR-012 (fetched-fresh
   updater, relocation, settings write).

Version comparison uses `package.json` semver — bumping `version` triggers rollout.

## Why

- Running the check synchronously would block Claude Code startup while waiting on a network response; off-VPN, DNS/TCP timeouts for internal hosts can take 20-30s.
- Splitting the fast synchronous throttle-check from the slow network-dependent update keeps the hook below 10ms regardless of network state.
- The timestamp is written only after a successful server contact, so a failed check (e.g. VPN off) is retried on the next session instead of being throttled for 24h.
- File updates use write-to-tmp + atomic rename, so a concurrent reader never observes a partially-written file.

## Alternatives considered

- **Always re-install via `npx git+<url>`**: requires git/npm at runtime, and reinstalls unrelated install logic (settings patching) even when only code changed.
- **Update check on every `SessionStart`, no throttle**: unnecessary network traffic and potential rate limiting on the update source.
- **`git ls-remote` for change detection**: no straightforward timeout and detects any commit, not just version bumps; a `package.json` HTTP fetch is simpler and faster.
- **Native `type: "http"` SessionStart hook**: would couple the update mechanism to the API backend serving version info; a raw-file fetch is simpler and self-contained.
