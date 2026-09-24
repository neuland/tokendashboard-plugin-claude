#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Mirror Claude Code's config-dir resolution: CLAUDE_CONFIG_DIR overrides ~/.claude.
// Duplicated from hook.js, this module must stay load-independent from hook.js.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'tokendashboard-plugin');
const LOCAL_STORAGE_DB_PATH = path.join(PLUGIN_DIR, 'local.sqlite');
const PRICES_CACHE_PATH = path.join(PLUGIN_DIR, 'prices.json');
const PRICE_SCHEMA_VERSION = 1;

function ensurePluginDir() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
}

function logError(context, err) {
  try {
    ensurePluginDir();
    fs.appendFileSync(path.join(PLUGIN_DIR, 'error.log'), `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- Local storage (SQLite) ---
//
// Local, queryable per-turn storage — separate from the queue (which is transient,
// deleted once sent) and network-independent.

// No schema versioning yet (no migrations).
// Add PRAGMA user_version + migrations once the schema needs to change under existing data.
function ensureLocalStorageSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_entries (
      entry_id            TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL,
      timestamp            TEXT NOT NULL,
      model                TEXT NOT NULL,
      input_tokens         INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      ephemeral_5m_tokens  INTEGER NOT NULL DEFAULT 0,
      ephemeral_1h_tokens  INTEGER NOT NULL DEFAULT 0,
      price_cents          REAL NOT NULL DEFAULT 0,
      project              TEXT,
      git_project          TEXT,
      branch               TEXT,
      type                 TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_entries_timestamp ON usage_entries(timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_entries_session_id ON usage_entries(session_id)');
}

// Opens (creating + migrating if needed) the local storage DB. WAL + busy_timeout for
// concurrency-safety across parallel hook invocations (Stop/SubagentStop/SessionEnd) —
// no separate lock file needed, unlike the queue. Caller must close().
function openLocalStorageDb() {
  const { DatabaseSync } = require('node:sqlite');
  ensurePluginDir();
  const db = new DatabaseSync(LOCAL_STORAGE_DB_PATH);
  // busy_timeout MUST be set before any statement that can contend (including the
  // journal_mode switch itself) — under real multi-process concurrency (multiple
  // worktrees/projects sharing this global DB), setting journal_mode first throws
  // "database is locked" instead of waiting, since nothing is yet configured to wait.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  ensureLocalStorageSchema(db);
  return db;
}

// Detects the specific failure of require('node:sqlite') on Node <22.13
// (ERR_UNKNOWN_BUILTIN_MODULE) so writeLocalStorage can log a clear, actionable message
// instead of the raw exception.
function isMissingSqliteModule(err) {
  return err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
    && String(err?.message ?? '').includes('node:sqlite');
}

// Upserts one row keyed by entry_id - a re-capture
// of the same turn (e.g. catchUpCapture re-aggregating a Stop-already-captured turn, or a
// finalized value replacing a stale snapshot) overwrites rather than duplicates. Never
// throws — a local-storage write must not block the queue write or capture() itself; on
// failure (including a missing node:sqlite) the row is simply skipped, no fallback storage.
function writeLocalStorage(entry) {
  let db;
  try {
    db = openLocalStorageDb();
    const usage = entry.usage || {};
    db.prepare(`
      INSERT INTO usage_entries (
        entry_id, session_id, timestamp, model,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
        ephemeral_5m_tokens, ephemeral_1h_tokens, price_cents, project, git_project, branch, type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        session_id = excluded.session_id,
        timestamp = excluded.timestamp,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        ephemeral_5m_tokens = excluded.ephemeral_5m_tokens,
        ephemeral_1h_tokens = excluded.ephemeral_1h_tokens,
        price_cents = excluded.price_cents,
        project = excluded.project,
        git_project = excluded.git_project,
        branch = excluded.branch,
        type = excluded.type
    `).run(
      entry.entry_id,
      entry.session_id,
      entry.timestamp,
      entry.model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      Math.max(
        (usage.cache_creation_input_tokens ?? 0)
        - (usage.ephemeral_5m_input_tokens ?? 0)
        - (usage.ephemeral_1h_input_tokens ?? 0),
        0,
      ),
      usage.cache_read_input_tokens ?? 0,
      usage.ephemeral_5m_input_tokens ?? 0,
      usage.ephemeral_1h_input_tokens ?? 0,
      entry.price_cents ?? 0,
      entry.project ?? null,
      entry.git_project ?? null,
      entry.branch ?? null,
      entry.type ?? null,
    );
  } catch (err) {
    if (isMissingSqliteModule(err)) {
      logError('writeLocalStorage', `Node 22.13+ needed for local storage (node:sqlite unavailable in ${process.version})`);
    } else {
      logError('writeLocalStorage', err);
    }
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// Resolves `cwd` to the BASE worktree of its repo. An agent can run inside an isolated
// `git worktree` (a separate working directory sharing the same repo/history) whose own
// folder name and checked-out branch are transient/random (e.g. Claude Code's own
// `.claude/worktrees/agent-<hash>` isolation worktrees, or any team's manually-created
// ones) — meaningless for reporting. `git worktree list` always lists the ORIGINAL
// ("main") worktree first, regardless of which worktree the command runs from (all
// worktrees of a repo share one git dir), so this resolves to it. For a plain,
// non-worktree repo (the common case) the first entry is `cwd`'s own repo root, so
// project/branch detection is unchanged. Falls back to `cwd` itself (never throws) when
// `git` is missing, `cwd` isn't a repo, or the output is unparseable.
function resolveBaseWorktree(cwd) {
  try {
    const res = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
    if (res.status !== 0) {
      return cwd;
    }
    const firstLine = res.stdout.split('\n').find(l => l.startsWith('worktree '));
    return firstLine ? firstLine.slice('worktree '.length).trim() : cwd;
  } catch {
    return cwd;
  }
}

// Project identity = active folder name of the BASE worktree (see resolveBaseWorktree),
// not the remote URL or full path. `null` cwd yields `null`, never throws.
// Claude Code can run outside a git repo (or any folder with a stable name) entirely.
function detectProject(cwd) {
  if (!cwd) {
    return null;
  }
  return path.basename(resolveBaseWorktree(cwd));
}

// Active git branch of the BASE worktree (see resolveBaseWorktree) — an isolation
// worktree's own branch (e.g. "worktree-agent-<hash>") is not what a report should
// attribute cost to. Via a synchronous `git` call — cheap relative to the poll loops
// around it, and local.sqlite writes are already best-effort/non-blocking. Missing `git`
// binary, `cwd` not a repo (Claude Code is not required to run inside one), or any other
// failure all fall back to `null` (never throws, same principle as writeLocalStorage
// itself).
function detectBranch(cwd) {
  if (!cwd) {
    return null;
  }
  try {
    const baseCwd = resolveBaseWorktree(cwd);
    const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: baseCwd, encoding: 'utf8' });
    if (res.status !== 0) {
      return null;
    }
    return res.stdout.trim() || null;
  } catch {
    return null;
  }
}

// Walks up from `cwd` looking for a `.git` entry (dir or file — a linked worktree/
// submodule has a `.git` file, not a dir) at each level, stopping at (and including)
// the user's home directory or the filesystem root, whichever comes first — never walks
// above home. Returns the basename of the first dir that has one, or null if none does.
// Distinct from detectProject/resolveBaseWorktree: this is the immediate repo cwd sits
// in (e.g. `backend`), not the base worktree of an isolation worktree — it exists to
// disambiguate two same-named repos (e.g. two independent `backend` checkouts) that
// resolveBaseWorktree can't tell apart. Local.sqlite-only, like project/branch.
function detectGitProject(cwd) {
  if (!cwd) {
    return null;
  }
  const home = os.homedir();
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return path.basename(dir);
    }
    if (dir === home) {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// --- Price lookup for local storage (capture-time, not statusline's render-time copy) ---
//
// Duplicated from hook.js and statusline.js rather than shared (ADR-012: pluginFiles
// auto-update per-file, not in lockstep, so no module here may require() another
// pluginFile). Used to fill local.sqlite's price_cents at capture time — the
// queue/backend payload is unaffected, price there is computed server-side.

// {} (not null) on absent/unparseable/unrecognized-schema, so callers can read
// `.fetchedAt` without a separate existence check.
function loadPricesCache() {
  try {
    const data = JSON.parse(fs.readFileSync(PRICES_CACHE_PATH, 'utf8'));
    if (data?.schema !== PRICE_SCHEMA_VERSION) {
      return {};
    }
    return data;
  } catch {
    return {};
  }
}

// Anthropic list prices, cents per million tokens; hardcoded default, overridable per
// model by the cached table (see ADR-017). Keep in sync with hook.js's removal and
// statusline.js's copy.
const PRICE_TABLE = {
  fable: { input: 1000, output: 5000, cacheWriteGeneric: 1250, cacheRead: 100, cacheWrite5m: 1250, cacheWrite1h: 2000 },
  opus: { input: 500, output: 2500, cacheWriteGeneric: 625, cacheRead: 50, cacheWrite5m: 625, cacheWrite1h: 1000 },
  sonnet: { input: 200, output: 1000, cacheWriteGeneric: 250, cacheRead: 20, cacheWrite5m: 250, cacheWrite1h: 400 },
  haiku: { input: 100, output: 500, cacheWriteGeneric: 125, cacheRead: 10, cacheWrite5m: 125, cacheWrite1h: 200 },
};

// Longest (most specific) matching table key wins over insertion order (see statusline.js).
// null (not a default) when no key matches, so callers treat it as "price unknown".
function matchPriceKey(model, table = PRICE_TABLE) {
  if (typeof model !== 'string') {
    return null;
  }
  const lower = model.toLowerCase();
  return Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find(key => lower.includes(key)) ?? null;
}

// Micro-cents (rate * tokens, not yet /1e6) for one model's usage. Cache-write tokens price
// by TTL bucket (ADR-014) where known; the remainder falls back to the generic rate. Returns
// null (not 0) on an unmatched model so the caller can leave price_cents unset rather than
// silently recording a wrong zero.
function priceMicroCentsForModel(model, u, table = PRICE_TABLE) {
  const key = matchPriceKey(model, table);
  if (!key) {
    return null;
  }
  const p = table[key];
  const unknownTtl = Math.max(0, u.cache_creation_input_tokens - u.ephemeral_5m_input_tokens - u.ephemeral_1h_input_tokens);
  return (
    u.input_tokens * p.input
    + u.output_tokens * p.output
    + u.ephemeral_5m_input_tokens * p.cacheWrite5m
    + u.ephemeral_1h_input_tokens * p.cacheWrite1h
    + unknownTtl * p.cacheWriteGeneric
    + u.cache_read_input_tokens * p.cacheRead
  );
}

// Validates one cached entry (already in the short internal field shape written by
// hook.js's sanitizePriceTable/fetchPrices) — same fields, distinct name from that file's
// sanitizePriceEntry, which validates the RAW fetch response's long field names instead.
function sanitizeCachedPriceEntry(v) {
  if (!v || typeof v !== 'object') {
    return null;
  }
  const fields = ['input', 'output', 'cacheWriteGeneric', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
  const out = {};
  for (const f of fields) {
    const n = v[f];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return null;
    }
    out[f] = n;
  }
  return out;
}

// Merges validated cached entries over PRICE_TABLE per model — one bad cached entry must not
// regress every other, correctly-cached model back to the hardcoded rate.
function effectivePriceTable() {
  const cached = loadPricesCache().table;
  if (!cached) {
    return PRICE_TABLE;
  }
  const merged = { ...PRICE_TABLE };
  for (const [model, entry] of Object.entries(cached)) {
    const sanitized = sanitizeCachedPriceEntry(entry);
    if (sanitized) {
      merged[model] = sanitized;
    }
  }
  return merged;
}

// Cents (not micro-cents) for one model's usage, or null if the model matches no price key.
function priceCentsForModel(model, u, table = effectivePriceTable()) {
  const micro = priceMicroCentsForModel(model, u, table);
  return micro === null ? null : micro / 1e6;
}

module.exports = {
  LOCAL_STORAGE_DB_PATH,
  ensureLocalStorageSchema,
  openLocalStorageDb,
  isMissingSqliteModule,
  writeLocalStorage,
  resolveBaseWorktree,
  detectProject,
  detectBranch,
  detectGitProject,
  PRICE_TABLE,
  PRICE_SCHEMA_VERSION,
  matchPriceKey,
  priceMicroCentsForModel,
  sanitizeCachedPriceEntry,
  effectivePriceTable,
  priceCentsForModel,
};
