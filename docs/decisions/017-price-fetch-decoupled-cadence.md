# ADR-017: Weekly, VPN-Gated Price Fetch Decoupled from Code Auto-Update

## Decision

`fetchPrices()` lives in `hook.js` (not `updater.js`), reusing the same VPN-gated-fetch pattern as `flush()` and the same `apiBaseUrl` (ADR-016), joined with a hardcoded
`PRICES_ROUTE` suffix. It's triggered from its own independent branch inside `checkUpdate()`, every `SessionStart`, gated by its own throttle against `prices.json`'s own
`fetchedAt` — never against `config.lastUpdateCheck`/`migrationBlocked`/the 24h code-update throttle, and vice versa. `fetchedAt` is stamped only on a successful run, so a failed
weekly attempt (no VPN yet) retries on the very next `SessionStart` rather than waiting another week.

Cached prices live in a dedicated `prices.json` (schema-versioned), not a `config.json` field, written with one atomic whole-file write and no lock:

```json
{
  "schema": 1,
  "fetchedAt": "...",
  "table": {
    "sonnet": {
      "input": 300,
      "output": 1500,
      "cacheWriteGeneric": 375,
      "cacheRead": 30,
      "cacheWrite5m": 375,
      "cacheWrite1h": 600
    }
  }
}
```

The price route's own field names (`inputCentPerMillion`, etc.) are remapped via `PRICE_FIELD_MAP`; `sanitizePriceEntry`/`sanitizePriceTable` validate and drop invalid entries *
*individually** — one bad model entry never invalidates the response, and a response with nothing valid leaves the existing cache untouched. `statusline.js`'s
`effectivePriceTable()` merges cached entries over the hardcoded `PRICE_TABLE` **per model**, and `matchPriceKey` sorts candidate keys by length (longest first) rather than relying
on table insertion order.

## Why

- The code auto-update source is now a public repo and must keep working without VPN; the price source is reachable only via VPN. Different reachability assumptions and different
  natural cadences (prices change far less often than code) mean the two must not share a throttle or a trigger path.
- `statusline.js` never makes a network call at render time — only reads whatever was last cached — so a slow or failed price fetch never affects statusline responsiveness.
- A dedicated file (not a `config.json` field) avoids a race with `uninstall()`, which deletes `config.json` first and uses its absence/presence as an in-flight `converge()`'s "
  still installed" guard; a racing price-fetch write to `config.json` could resurrect it after uninstall.
- No lock is needed: the fetch is a single whole-file atomic write with no read-modify-write, so two racing writers are safe last-writer-wins.
- `schema` versioning matters because `hook.js` and `statusline.js` are both `pluginFiles` but download per-file atomically, not as a set (ADR-012) — one can briefly be a version
  ahead of the other. An unrecognized `schema` falls back to the hardcoded table wholesale rather than a partial read.
- Per-model (not whole-table) fallback means one malformed cached entry doesn't regress every other valid cached price back to hardcoded rates.
- Longest-key-first matching is required once the effective table can mix fetched and hardcoded keys — otherwise a specific key (`sonnet-4-5`) could become permanently unreachable
  behind a more generic one (`sonnet`).
- No error is logged when the price route is missing/unreachable — unlike `flush()`, this is expected steady state for a fork whose backend doesn't implement the route.

## Alternatives considered

- **A second URL flag for the price route**: rejected — both routes live on the same host, and a differently-shaped fork backend needs source changes regardless of URL granularity.
  Reusing `apiBaseUrl` needed no new install flag.
