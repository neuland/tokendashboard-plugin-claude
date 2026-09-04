# ADR-018: Plugin Directory Renamed to `tokendashboard-plugin`

## Decision

The plugin's data directory moves from `~/.claude/token-usage-plugin/` to `~/.claude/tokendashboard-plugin/`, matching the project name. The directory constant is duplicated in
all three source files (`hook.js`, `updater.js`, `statusline.js` — they deliberately share no code, see ADR-012), so all three move together in one version.

Three mechanisms carry existing installs across the rename, all of them in `updater.js`:

1. **`HOOK_MATCH` matches both names.** `/(?:token-usage-plugin|tokendashboard-plugin)[/\\.]/` — so `hooksAreCurrent` reads an old-dir entry as drift (`ours.length !== 1`, or a
   single entry whose command differs), `patchSettings` strips *every* matching entry per event and pushes exactly one new-dir command. A settings.json carrying both an old and a
   new entry therefore collapses to the new one, rather than running the same hook twice per event. The `[/\\.]` separator guard still excludes unrelated commands merely starting
   with the name (`tokendashboard-plugin-exporter.js`, the repo dir `tokendashboard-plugin-claude/`), and the old alternative still catches the pre-0.4.0 file
   `hooks/token-usage-plugin.js` (ADR-010, ADR-012).
2. **`adoptLegacyInstall()` runs first in `converge()`, before the `currentVersion` guard.** When the new dir has no `config.json` but the old one holds a config with a
   `currentVersion`, it is copied across (minus `lastUpdateCheck`), along with `user-id`. From there the migration is an ordinary converge: payload files are missing in the new dir
   so they download, and settings drift so they repoint.
3. **`converge()` repoints `statusLine` as well as the hooks.** Drift is *only* an entry that is already ours (matched by the `statusline.js` basename) but whose command differs from
   the current one; converge never *adds* a `statusLine` and never touches a foreign one.
4. **`uninstall()` deletes the old `config.json` too**, in the same early block as the new one.

The old directory is otherwise left in place, and any entries still queued in `~/.claude/token-usage-plugin/queue/` are discarded — not migrated.

## Why

- **Without adoption, no existing install ever migrates.** An install is only visible to `converge()` through `config.json`. After the rename that file sits in the old dir, so the
  `if (!config.currentVersion) return` guard reads "not installed" and returns — every session would re-fetch `updater.js` and no-op forever, never even stamping `lastUpdateCheck`
  to throttle itself. Adoption has to happen before that guard for the rename to roll out at all.
- **The migration logic lives in the one file that is fetched fresh and never stored** (ADR-012). A bug in adoption is fixed by publishing a new `updater.js`, retroactively, for
  everyone — which is why the whole rename is driven from here rather than from `hook.js`'s loader.
- **`lastUpdateCheck` is dropped during adoption**, not carried over: if this converge fails (no network), the next `SessionStart` must retry immediately rather than inherit an
  up-to-24h throttle from the old install. `converge()` re-stamps it once it reaches a terminal state.
- **`user-id` is copied.** It is the dashboard's pseudonymous identity (ADR-006); without it every existing user would appear as brand new with no history. Unlike the queue, that
  is a data-integrity loss, not a handful of unsent turns. It is only ever copied when the new dir has none, so it can never clobber a fresh identity.
- **`statusLine` had to join the drift check.** Before the rename its command string never changed — converge overwrote `statusline.js` behind a fixed path. The rename makes it a
  path that must move, and `hooksAreCurrent`/`patchSettings` only ever looked at `settings.hooks`. Left alone, an auto-updated install would keep executing the *0.7.0*
  `statusline.js` still sitting in the old dir, reading the old dir's now-abandoned `config.json` (version pinned at 0.7.0), `queue/` (backlog permanently invisible, sync dot stuck
  on "synced") and `prices.json` — and it would never self-heal, since `downloadPluginFiles` only ever writes into the new dir. Restricting drift to "ours but stale" keeps ADR-012's
  zero-writes-in-steady-state property intact in all three states: ours-and-correct → no drift; foreign → no drift (the non-destructive rule `installStatusLine` already follows);
  absent → no drift, because an absent entry is the documented "drop the statusline, keep the plugin" state and re-adding it would rewrite `settings.json` every session.
- **`uninstall()` must clear the old config**, or it becomes a resurrection key: a racing `converge()` would adopt it and revive an install that was just torn down — the same
  invariant ADR-012 and ADR-017 protect. Adoption additionally re-checks that the old config still exists after copying and undoes itself if it vanished mid-copy, narrowing the
  race further.
- **A failed migration self-heals.** Adopt, then a download fails: the new dir has a config but no payload, `filesReady` is false so settings are not repointed (files-before-
  settings, ADR-012), no `lastUpdateCheck` is stamped in the new dir, and the still-installed old hook keeps capturing from the old dir until a later session retries (bounded by whatever `lastUpdateCheck` the *old* config still carries, i.e. at most the normal 24h throttle).
- **`LEGACY_HOOK_DEST` keeps its old name.** It refers to the pre-0.4.0 single hook *file* (`hooks/token-usage-plugin.js`), a different thing from the pre-0.8.0 *directory*;
  renaming it would stop `uninstall()` from cleaning it up.

## Alternatives considered

- **Migrating the queue**: rejected — it would mean a lock-coordinated cross-directory move for at most a session's worth of unsent entries, against `updater.js` code that has no
  other reason to know the queue's format. Losing them costs a few turns of telemetry.
- **`fs.renameSync` of the whole directory**: rejected — not atomic across the concurrent readers/writers of a parallel session still bound to the old path, and it would strand
  that session's hook mid-write. Downloading a fresh payload into the new dir is the path already exercised by ADR-012's relocation.
- **Driving the rename from `hook.js`'s loader** (as ADR-012's relocation was): rejected — that migration needed the loader because the *frozen v0.3.5 updater* could only fetch
  `main/hook.js`. Every install that can reach this rename already runs a fetched-fresh `updater.js`, so the logic belongs in the file that can still be fixed after the fact.

## Consequences

- A host and a devcontainer sharing a mounted `~/.claude` may briefly run different plugin versions against one `settings.json`. The pre-0.8.0 `HOOK_MATCH` does not recognize the
  new command, so the older environment's `converge` reads drift and re-adds the old entry — a short ping-pong, and briefly the double hook this ADR removes. It resolves once both
  environments update; running `npx … install` manually in both collapses the window immediately. The `statusLine` half is one-directional — the pre-0.8.0 `converge` doesn't touch
  `statusLine` at all, so it can't fight the repoint back.
- `~/.claude/token-usage-plugin/` remains on disk as an unreferenced leftover. Nothing executes from it once settings are repointed, and `uninstall` does not remove it.
