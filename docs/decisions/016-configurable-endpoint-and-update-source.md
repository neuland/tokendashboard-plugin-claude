# ADR-016: Configurable, Required API Base URL and Update Source

## Decision

Two install-time CLI flags on `updater.js`'s `bin` entry, **required on every install/reinstall**, stored in `config.json`, and never read back from a previously stored value (a
flag omitted on a re-run is a hard error, not a silent reuse):

- **`--api-base-url <url>`** — the API host for usage ingest and the price table (ADR-017). Stored as `apiBaseUrl`. It is a base URL, not a full route: `hook.js` appends fixed,
  hardcoded suffixes (`INGEST_PATH`, `PRICES_ROUTE`) via the shared `rawUrl(base, file)` helper. `flush()` refuses to send (keeping the queue) when it's absent; `fetchPrices()`
  silently no-ops instead. A bare origin with no path is valid (`isPlausibleUrl(value, { requirePath: false })`).
- **`--repo-raw-base-url <url>`** — the raw-file base URL the plugin auto-updates from. Stored as `repoRawBaseUrl`; `converge()`/`updateFromRemote()` read it directly with no
  fallback constant, and no-op (like "not installed") if it's absent. Passing the raw-file base URL directly (rather than a repo URL) avoids needing host-detection logic — GitHub,
  GitLab, and self-hosted git all have differently-shaped raw-file paths. This flag still requires a path (`requirePath: true`, the default) since nothing is appended to it.

`main()`/`run()` rejects `install` if either flag is missing, on every invocation including a reinstall; `install()` always writes exactly what was passed in, never merged with an
existing config value.

## Why

- The API host is inherently deployment-specific (every install needs its own private backend) — there is no sane default.
- The update source is host-specific (GitLab's `/-/raw/main/<file>` vs. GitHub's `raw.githubusercontent.com/<org>/<repo>/main/<file>` have no common shape); a hardcoded constant
  would break the moment this project's own host changes again, or would point a fork at a raw-file path it can't resolve.
- Requiring both flags explicitly, with no default and no read-back, makes the update source and API host a conscious choice on every install rather than an easy-to-miss stale
  override.
- One base URL with fixed route suffixes (rather than one URL per route) is enough: a fork with a differently-shaped backend needs source changes regardless of URL granularity, so
  per-route configurability buys nothing. A future second route on the same host needs only a new hardcoded suffix constant, no new flag.

## Alternatives considered

- **Environment variables instead of CLI flags**: `npx git+<url>.git install` is typically one-shot; an env var is less discoverable than a documented flag.
- **Auto-detect the raw-file URL shape from a plain repo URL**: no common derivation exists across git hosts; unbounded host-sniffing maintenance for no real benefit.
- **A hardcoded default pointing at this project's own repo**: silently ties every fork to this project's update stream, and becomes stale the moment this repo's own host changes (
  as already happened once).
