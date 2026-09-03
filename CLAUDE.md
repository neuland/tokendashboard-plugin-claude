# tokendashboard-plugin-claude

Claude Code hook plugin that captures token usage per model and forwards it to an internal HTTP endpoint. Handles offline scenarios (VPN not active) via a local store-and-forward queue. Auto-updates silently on session start by fetching a fresh `updater.js` and running it (see ADR-012).

## Files

| File | Purpose |
|---|---|
| `hook.js` | Durable payload (installed + auto-updated). Capture/flush + a minimal loader. Modes: default (main-turn capture), `--subagent-stop` (subagent capture), `--flush`, `--check-update` (loader), `--update` (fetch+run `updater.js`), `--fetch-prices` (weekly, VPN-gated price cache refresh — see ADR-017). |
| `updater.js` | All lifecycle logic: `install`/`uninstall` (the `npx` `bin` entry, includes statusline install/uninstall) and `converge` (fetched fresh, run via stdin). **Not** a durable file — never installed to disk. |
| `statusline.js` | `statusLine` command script. Reads plugin state (queue backlog, error.log, cached `prices.json`) and the transcript to render a model name + token-count + sync-health segment + a context-window usage bar, read from the stdin payload. A `pluginFiles` entry, auto-updated the same way as `hook.js` — but deliberately self-contained (does not `require('./hook.js')` or `updater.js`, see file comment) since per-file-atomic downloads mean the two can briefly land a version apart within one converge; it reads `prices.json`'s file format directly (versioned by `schema`, see ADR-017), not `hook.js` code. |
| `package.json` | Package manifest. Bump `version` to trigger auto-update rollout; `pluginFiles` lists durable auto-updated payload files (`hook.js` and `statusline.js`). |
| `docs/decisions/` | Architecture Decision Records (ADRs). |

## Architecture

Four hooks registered in `~/.claude/settings.json` (command path is `$HOME/.claude/tokendashboard-plugin/hook.js` on POSIX):

| Hook | Command | Purpose |
|---|---|---|
| `SessionStart` | `node hook.js --check-update` | Loader: spawn background flush (always) + (once/24h, or immediately if not yet migrated) spawn `--update` + (once/7d, independent of the code-update throttle) spawn `--fetch-prices` |
| `Stop` | `node hook.js` | Read main transcript, write main-agent entry to queue |
| `SubagentStop` | `node hook.js --subagent-stop` | Read the completed subagent's own transcript (`agent_transcript_path`), write entry to queue (see ADR-013) |
| `SessionEnd` | `node hook.js --flush` | Re-aggregate the main transcript's trailing turns (`catchUpCapture`, recovers turns `Stop` never fired for — see ADR-015), then send queue to API endpoint |

`--update` fetches `updater.js` fresh and runs it via `node -` (stdin); the updater's `converge` downloads any changed `pluginFiles` and repoints `settings.json` on drift.

Plus a `statusLine` entry (`node statusline.js`), re-invoked by Claude Code on render (not a hook event), rendered as two lines. Line 1: `model · tokens · dot syncSegment · context window: bar pct`. 
The model name and token count come from the stdin payload / transcript. The sync dot is colored via `dot()`: red when there's a recent error *and* a nonempty queue, or when the oldest queued entry exceeds `STALE_QUEUE_MS` (24h); 
dimmed/none while items are merely queued; blue when synced. `formatProgressBar` renders the bar itself uncolored (plain `▓`/`░`); coloring lives on the percentage text via `formatPct` instead — no color below ~40%, bright magenta ~40-79%, red 80%+ — independent of the sync dot's thresholds; 
`pct` appends ` COMPACT!` at 80%+. Line 2: `tokendashboard-plugin vVERSION · ↑in / ↓out tokens · $price` (network RX/TX convention: ↑ = sent/input tokens, ↓ = received/output tokens). 
Version is read from `config.json`'s `currentVersion` (falls back to `unknown`). Price is computed per-model from `effectivePriceTable()` — a hardcoded `PRICE_TABLE` (cents per million tokens) with any locally-cached, per-model overrides from `prices.json` merged in (see ADR-017; a malformed/absent cached entry falls back to the hardcoded rate for that model only) — matched against `message.model` by substring via `matchPriceKey` (longest/most-specific key wins, not table order, since the effective table is no longer curated at authoring time); 
cache-write tokens are priced per ADR-014's TTL breakdown (5m/1h) where available, falling back to a generic cache-write rate for the remainder. A model that matches no key in the effective table prices as 0 and marks the whole total `incomplete` (same `≥` lower-bound marker as the subagent case), rather than silently under-pricing. `prices.json` is read locally only — the statusline never makes a network call at render time.

Local files written by the plugin (paths below assume the default config dir; both
`hook.js` and `updater.js` resolve `CLAUDE_CONFIG_DIR || ~/.claude` to match Claude Code):

| Path | Purpose |
|---|---|
| `~/.claude/tokendashboard-plugin/hook.js` | Installed hook script (auto-updated) |
| `~/.claude/tokendashboard-plugin/statusline.js` | Installed statusline script (auto-updated — a `pluginFiles` entry, same as `hook.js`) |
| `~/.claude/tokendashboard-plugin/config.json` | `currentVersion` + `lastUpdateCheck` timestamp + `migrationBlocked` flag + `apiBaseUrl`/`repoRawBaseUrl` (see ADR-016) |
| `~/.claude/tokendashboard-plugin/prices.json` | Cached price table (`schema`/`fetchedAt`/`table`), written by `hook.js`'s weekly `--fetch-prices`; read locally by `statusline.js` at render time — no network at render (see ADR-017) |
| `~/.claude/tokendashboard-plugin/user-id` | Random UUID for user pseudonymization |
| `~/.claude/tokendashboard-plugin/queue/` | Per-entry queue files (`[timestamp]-[pid].json`) |
| `~/.claude/tokendashboard-plugin/.update.lock` | Update lock (separate from the flush lock) |
| `~/.claude/hooks/token-usage-plugin.js` | Legacy pre-0.4.0 location; orphaned after migration, removed only on uninstall |
| `~/.claude/token-usage-plugin/` | Legacy pre-0.8.0 data dir; orphaned after the rename (its queue is discarded, only `config.json` + `user-id` are adopted). Never removed — but its `config.json` IS deleted on uninstall (see ADR-018) |

## Code style

After editing any source file (`hook.js`, `updater.js`), both the linter and the unit tests must pass before the change is considered done:

```bash
npm run lint
npm test
```

All ESLint errors must be resolved and all unit tests must pass — no exceptions.

## Testing

Tests use the built-in `node:test` runner (no extra dependency). Run with:

```bash
npm test
```

Conventions:

- Structure every test with `// given`, `// when`, `// then` comments marking the three phases. When a test is a series of one-line assertions where each line is itself given+when+then (e.g. table-style checks), collapse them under a single combined comment instead of splitting artificially.
- Because the plugin writes into `~/.claude/*` via constants derived from `os.homedir()` at load time, fs-touching tests run inside an isolated temp `$HOME`. Use `inSandbox(fn)` (loads `hook.js`) or `inUpdaterSandbox(fn)` / `inUpdaterSandboxAsync(fn)` (loads `updater.js`) from `test/helpers.js` — they redirect `$HOME`, load a fresh module, and guarantee cleanup. Prefer real temp dirs over mocking `fs`.
- `hook.js` runs `main()` only under `require.main === module`; `updater.js` runs `main()` under `require.main === module || process.env.TUP_MODE` (the stdin/fetched-run path). Both are safe to `require` in tests; all testable functions are exported at the bottom.

## Critical constraints

- **Do not change the queue to a single file.** Per-file pattern is required for concurrency safety (see ADR-004).
- **Do not move flush into `Stop`.** Flush runs once per session, not per turn (see ADR-003).
- **Lock file** (`~/.claude/tokendashboard-plugin/queue/.lock`) must always be released in a `finally` block. Stale locks (owning process dead) are automatically stolen on next acquire.
- **Atomic rename** for self-update and `settings.json` writes: write to `.tmp` first, then `fs.renameSync` (see ADR-007, ADR-012). Multi-file downloads are per-file atomic, not set-atomic — `currentVersion` bumps only after every `pluginFile` lands.
- **`hook.js` and `statusline.js` are both `pluginFiles` entries and both auto-update.** `statusline.js` is deliberately self-contained (does not depend on `hook.js`/`updater.js` internals) so it keeps working correctly even when a converge has landed one of the two files a version ahead of the other (downloads are per-file atomic, not set-atomic) — that is a robustness property, not a reason it's excluded from auto-update. Only `updater.js` and `package.json` require a manual `npx` re-run (`updater.js` is fetched fresh on every update instead of being a stored `pluginFiles` entry; `package.json` changes like `pluginFiles` itself can't self-apply).
- **`statusLine` install/uninstall is non-destructive, and `converge` only ever *repoints* it (never adds one).** Lives in `updater.js` (ported from the removed `cli.js`). A pre-existing foreign `statusLine` entry (user's own, or another plugin's) is left untouched — matched by whether its command includes the installed statusline script's filename, same pattern as `removeOwnHooks`.
- **Subagent `output_tokens` repair.** A subagent's final API call is sometimes persisted to its transcript non-finalized (`stop_reason: null`, stale `output_tokens`). `aggregateUsage` repairs the last message from the main transcript's `toolUseResult.usage` — do not drop the `finalizedUsage` plumbing (see ADR-009).
- **`$HOME`-relative hook command.** The hook command is `$HOME/.claude/tokendashboard-plugin/hook.js` on POSIX so a mounted `~/.claude` works across host and devcontainer; it falls back to an absolute path on Windows or a custom `CLAUDE_CONFIG_DIR` outside `$HOME`. This string must be **identical** in both environments — `converge` uses it as the settings-drift key, so a divergence would ping-pong `settings.json`. `removeOwnHooks` matches on the substring `tokendashboard-plugin` **or** the pre-0.8.0 `token-usage-plugin` (so it catches the current, the pre-0.8.0 and the pre-0.4.0 command), not a filename — do not narrow it back (see ADR-010, ADR-012, ADR-018).
- **No hardcoded `REPO_URL`/default update source anywhere in source (see ADR-016).** `--repo-raw-base-url <url>` is **required** at install time, stored as `repoRawBaseUrl` in `config.json`, so a fork or self-hosted deployment must point auto-update at its own git host — there is no built-in fallback. The value stored/passed is the raw-file **base URL** directly (e.g. GitLab's `.../-/raw/main`, GitHub's `raw.githubusercontent.com/<org>/<repo>/main`) — not the repo URL itself — so no host-detection logic is needed. `converge()` (`updater.js`) and `updateFromRemote()` (`hook.js`) each read `loadConfig().repoRawBaseUrl` directly and no-op — exactly like the existing "not installed" guard — when it is absent. **Neither `--repo-raw-base-url` nor `--api-base-url` is ever read back from a previously stored `config.json` value** — `main()` rejects `install` if EITHER flag is missing, on every invocation including a reinstall, and `install()` always writes exactly what was passed in rather than merging with an existing value.
- **`apiBaseUrl` is a base URL with fixed, hardcoded route suffixes — not one URL per route (see ADR-016).** `--api-base-url <url>` is likewise not hardcoded and **required** at install time (parsed/validated in `updater.js`'s `main()`) and stored in `config.json`. `hook.js` appends fixed constants (`INGEST_PATH`, `PRICES_ROUTE`) to it via the shared `rawUrl(base, file)` helper — `flush()` for telemetry, `fetchPrices()` for the weekly price cache refresh — rather than taking a separate URL flag per route: a fork with a differently-shaped backend needs source changes regardless, so per-route configurability buys nothing. Unlike `--repo-raw-base-url`, a bare origin (no path) is a valid `--api-base-url` — `isPlausibleUrl(value, { requirePath })` defaults `requirePath` to `true` for the raw-file flag and is called with `false` for this one. `flush()` refuses to send (keeping the queue) when `apiBaseUrl` is absent; `fetchPrices()` silently no-ops (see below).
- **The pre-0.8.0 dir rename is carried by three things in `updater.js`, all of which must stay (see ADR-018).** (1) `HOOK_MATCH` matches `token-usage-plugin` *and* `tokendashboard-plugin` — this is what collapses an old + new entry pair down to one hook per event instead of running both; do not drop the old alternative. (2) `adoptLegacyInstall()` must run **before** `converge()`'s `currentVersion` guard: an existing install is only visible through `config.json`, which after the rename sits in the old dir, so without adoption every already-installed user silently never migrates. It copies `config.json` (minus `lastUpdateCheck`, so a failed migration retries next session instead of inheriting a 24h throttle) plus `user-id` (the ADR-006 pseudonymous identity — dropping it would make every existing user look brand new). (3) `uninstall()` deletes the **old** `config.json` too — leaving it behind makes it a resurrection key a racing `converge` would adopt, reviving a torn-down install. The old dir's queue and the dir itself are deliberately not migrated. `LEGACY_HOOK_DEST` keeps its `token-usage-plugin.js` name — that is the pre-0.4.0 *file*, a different thing from the pre-0.8.0 *directory*. `converge` additionally repoints `statusLine` via `statusLineNeedsRepoint`/`repointStatusLine` (the rename moved the path it points at, and the hooks drift check never looked at it) — drift is **only** an already-ours-but-stale command, never an absent one (that is the documented "drop the statusline, keep the plugin" state) and never a foreign one, or the steady-state-zero-writes property breaks.
- **Version bump on user-relevant changes.** Any change to the plugin that requires an update on already-installed users (i.e. touches `hook.js`, `updater.js`, or any other `pluginFiles` entry) must bump `version` in `package.json`, since that bump is what triggers the auto-update rollout (see `--check-update`). Default increment is `+0.0.1` (patch) unless the change warrants a larger bump.
- **`capture`/`flush` must stay local in `hook.js`** and network-independent — never behind the `updater.js` fetch, or telemetry breaks with no VPN (see ADR-012). Keep the loader minimal: it is the permanently-frozen update surface.
- **`converge` writes `settings.json` only on drift, and the drift check must stay scoped + environment-stable** (steady state = zero settings writes). This is what makes the automatic settings write safe against concurrent writers — do not replace it with a full-file compare (see ADR-012).
- **Migration is driven from `--check-update`, not from `converge`/the updater.** Updates are not sequential (the frozen v0.3.5 updater fetches only `main/hook.js`), so the first new-code entry point must relocate + repoint. Do not move this into the update step (see ADR-012).
- **Never auto-delete the legacy hook file.** A parallel pre-migration session may still be bound to it; it is removed only on explicit `uninstall` (see ADR-012).
- **Auto-update now covers `hook.js` + `pluginFiles` + `settings.json`.** Only `package.json` changes require a manual `npx` re-run (see ADR-012).
- **Subagents are captured from `SubagentStop`, not `Stop`.** Background subagents (the Agent-tool default) complete in a later turn than they launch, so the `Stop` path saw empty transcripts and its `toolUseResult` repair source was absent — it captured almost nothing. `--subagent-stop` reads the completed subagent's own `agent_transcript_path` once. Do **not** move subagent capture back into `Stop` (see ADR-013). Guard on `agent_transcript_path` existing (spurious `agent_type:""` firings reference no file).
- **Subagent finalization is handled by polling, not `toolUseResult`.** At `SubagentStop` time the subagent transcript's last line may be non-finalized (`stop_reason: null`, stale `output_tokens: 1`), and — unlike the old `Stop` path — there is no `toolUseResult.usage` to repair from. `readFinalizedLines` polls a generous window (~3s, longer than the main-turn poll) for the finalized line, then falls back to the stale snapshot rather than dropping the turn (see ADR-013). `aggregateUsage` keeps its dormant `finalizedUsage` parameter (still tested), but nothing in the capture paths passes it now — the ADR-009 `toolUseResult` plumbing was removed from `capture()`.
- **Both capture paths share one finalization predicate (see ADR-013).** `capture()` (Stop) and `readFinalizedLines` (SubagentStop) both judge "done" via `lastCountableAssistant` (backward scan for the chronologically last assistant with `usage` + `model` + `id`) and `isTerminalStop` (the `TERMINAL_STOP_REASONS` allowlist: `end_turn` / `stop_sequence` / `max_tokens` / `refusal` / `model_context_window_exceeded`). Do **not** reintroduce a `stop_reason !== null` denylist in either path — it wrongly treats `pause_turn`/`tool_use` as terminal and drops the resumed/final call. The `message.id` requirement in `isCountableAssistant` must match `aggregateUsage`'s id-dedup, or a poll can return early on an entry aggregation then drops. Only the poll **window** (main ≈1s, subagent ≈3s) and the timeout fallback differ.
- **Advisor token capture.** The `/advisor` feature runs server-side inside one executor API call; its tokens are billed to the advisor's own model but live only in `message.usage.iterations[]` under `type: "advisor_message"`, never in the flat `message.usage`. `aggregateUsage` must keep walking `iterations` and booking advisor usage to its own model — do not collapse it back to reading only the flat totals (see ADR-011).
- **Ephemeral cache-write TTL breakdown.** `usage.ephemeral_5m_input_tokens` and `usage.ephemeral_1h_input_tokens` are transmitted as flat siblings of `cache_creation_input_tokens` (not nested, unlike the API's own `message.usage.cache_creation` shape they're read from), summed in the same shared `accFor`/`addUsage` pair so every capture path (`Stop`, `SubagentStop`, advisor iterations) picks them up uniformly. Both default to `0` via `?.`/`?? 0` when a call's `cache_creation` breakdown is absent or partial — never error, never drop the entry, and never alter `cache_creation_input_tokens`'s own value (see ADR-014).
- **Price fetch is decoupled from code auto-update in both cadence and reachability (see ADR-017).** `--fetch-prices` runs weekly (`PRICE_UPDATE_INTERVAL_MS`), thrown by its own independent branch in `checkUpdate()` against `prices.json`'s own `fetchedAt` — never against `config.lastUpdateCheck`/`migrationBlocked`/the 24h code-update throttle, and vice versa. `fetchPrices()` (in `hook.js`, not `updater.js` — same VPN-gated-fetch pattern as `flush()`) writes `prices.json` as a single atomic whole-file write, no lock (no read-modify-write, unlike the queue/settings writers). It is a **dedicated file, not a `config.json` field**, specifically so a racing `--fetch-prices` child can never resurrect `config.json` after an `uninstall()` clears it (an in-flight `converge()` treats that file's presence as its own "still installed" guard). Any failure (unreachable, non-2xx, unparseable, no valid entries) leaves `prices.json` untouched and is retried next check — no error is logged for a missing price route (expected for a fork whose backend doesn't implement it), unlike `flush()`'s logged failure on a missing `apiBaseUrl`. `statusline.js` reads `prices.json` locally (never over the network) via `effectivePriceTable()`, merging cached entries over `PRICE_TABLE` **per model** — do not regress this to a whole-table fallback on one bad entry.
- **`Stop` never fires on a user interrupt or a denied tool permission** — only on a genuine turn completion. `capture()` is therefore never invoked for an aborted turn, so `SessionEnd`'s `catchUpCapture` re-aggregates the transcript's trailing turns (bounded to `CATCH_UP_MAX_TURNS`) and relies on the existing `entryId` dedup hash to safely re-send already-captured turns as no-ops while recovering ones `Stop` missed. `isTurnOriginEntry` (the "is this a real turn boundary" predicate) is shared verbatim between `capture()` and the catch-up path — do not let the two diverge, or a re-emitted turn's `entryId` stops matching its original `Stop`-captured hash and the server double-counts instead of deduping (see ADR-015).

## Install / Uninstall

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-claude.git install --api-base-url <url> --repo-raw-base-url <url>
npx git+https://github.com/neuland/tokendashboard-plugin-claude.git uninstall
```

Both `--api-base-url` and `--repo-raw-base-url` are required on every install/reinstall — neither
has a hardcoded default and neither is read back from a previously stored `config.json`
value (see ADR-016). `--api-base-url` is a host, not a full route — `hook.js` appends fixed
route suffixes for ingest (ADR-016) and price-fetch (ADR-017).
