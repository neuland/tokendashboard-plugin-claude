#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// Trailing-slash-safe join of a raw-file base URL with a filename. Duplicated in updater.js
// (not imported) — hook.js and updater.js don't share code (ADR-012).
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

// Mirror Claude Code's config-dir resolution: CLAUDE_CONFIG_DIR overrides ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'tokendashboard-plugin');
// Canonical location; compared against __filename to detect a not-yet-migrated install
// and force an immediate update (see ADR-012).
const HOOK_DEST = path.join(PLUGIN_DIR, 'hook.js');
const QUEUE_DIR = path.join(PLUGIN_DIR, 'queue');
const LOCK_FILE = path.join(QUEUE_DIR, '.lock');
const USER_ID_PATH = path.join(PLUGIN_DIR, 'user-id');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const TIMEOUT_MS = 30000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');
// Fixed routes appended to config.apiBaseUrl — not separately configurable (see ADR-016).
const INGEST_PATH = 'api/usage/ingest/claude';
const PRICES_ROUTE = 'api/prices/claude';
const PRICES_CACHE_PATH = path.join(PLUGIN_DIR, 'prices.json');
const LOCAL_HISTORY_DB_PATH = path.join(PLUGIN_DIR, 'local.sqlite');
const PRICE_SCHEMA_VERSION = 1;
const PRICE_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Cap how many entries go into a single POST so a long offline period can't build
// one oversized request that the endpoint rejects (and then never shrinks).
const FLUSH_BATCH_SIZE = 500;
// Drop queued entries older than this so the queue can't grow without bound when the
// endpoint is unreachable for a very long time (filename is enqueue-time-prefixed).
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let writeCounter = 0;

// --- Logging ---

function logError(context, err) {
  try {
    ensurePluginDir();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- Atomic write ---

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// --- User ID ---

function ensurePluginDir() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
}

function getUserId() {
  if (fs.existsSync(USER_ID_PATH)) {
    return fs.readFileSync(USER_ID_PATH, 'utf8').trim();
  }
  ensurePluginDir();
  const id = crypto.randomUUID();
  atomicWriteSync(USER_ID_PATH, id);
  return id;
}

// --- Config ---

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// --- Queue ---

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function writeEntry(entry) {
  ensureQueueDir();
  // Counter guarantees uniqueness when multiple writeEntry calls land in the same
  // millisecond inside one process. Atomic write (tmp + rename) so a concurrent flush in
  // another process never observes a half-written file under its final name (ADR-004).
  atomicWriteSync(
    path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${writeCounter++}.json`),
    JSON.stringify(entry),
  );
}

function getQueueFiles() {
  if (!fs.existsSync(QUEUE_DIR)) {
    return [];
  }
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => path.join(QUEUE_DIR, f));
}

// Queue filenames are `${Date.now()}-${pid}-${counter}.json`, so the leading number
// is the enqueue time in ms. Returns null for any file that doesn't match.
function enqueueTime(filePath) {
  const n = parseInt(path.basename(filePath), 10);
  return Number.isNaN(n) ? null : n;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  // Two attempts: first the normal wx, then once more after unlinking a stale lock.
  // wx is atomic, so even with multiple concurrent stealers only one ever wins the retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      // Steal unless a real, live process owns it. A NaN/0 pid means an empty or corrupt
      // lock (a crash between the wx-create and the pid write) and must be stealable, or the
      // flush queue would be blocked until the file is removed by hand.
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return false;
      }
      try {
        fs.rmSync(LOCK_FILE);
      } catch {}
    }
  }
  return false;
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE);
  } catch {}
}

// --- Local history (SQLite) ---
//
// Local, queryable per-turn history — separate from the queue (which is transient,
// deleted once sent) and network-independent.

// No schema versioning yet (no migrations) — too early, few installs. Add
// PRAGMA user_version + migrations once the schema needs to change under existing data.
function ensureLocalHistorySchema(db) {
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

// Opens (creating + migrating if needed) the local history DB. WAL + busy_timeout for
// concurrency-safety across parallel hook invocations (Stop/SubagentStop/SessionEnd) —
// no separate lock file needed, unlike the queue. Caller must close().
function openLocalHistoryDb() {
  const { DatabaseSync } = require('node:sqlite');
  ensurePluginDir();
  const db = new DatabaseSync(LOCAL_HISTORY_DB_PATH);
  // busy_timeout MUST be set before any statement that can contend (including the
  // journal_mode switch itself) — under real multi-process concurrency (multiple
  // worktrees/projects sharing this global DB), setting journal_mode first throws
  // "database is locked" instead of waiting, since nothing is yet configured to wait.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  ensureLocalHistorySchema(db);
  return db;
}

// Detects the specific failure of require('node:sqlite') on Node <22.13
// (ERR_UNKNOWN_BUILTIN_MODULE) so writeLocalHistory can log a clear, actionable message
// instead of the raw exception.
function isMissingSqliteModule(err) {
  return err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
    && String(err?.message ?? '').includes('node:sqlite');
}

// Upserts one row keyed by entry_id - a re-capture
// of the same turn (e.g. catchUpCapture re-aggregating a Stop-already-captured turn, or a
// finalized value replacing a stale snapshot) overwrites rather than duplicates. Never
// throws — a local-history write must not block the queue write or capture() itself; on
// failure (including a missing node:sqlite) the row is simply skipped, no fallback storage.
function writeLocalHistory(entry) {
  let db;
  try {
    db = openLocalHistoryDb();
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
      usage.cache_creation_input_tokens ?? 0,
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
      logError('writeLocalHistory', `Node 22.13+ needed for local history (node:sqlite unavailable in ${process.version})`);
    } else {
      logError('writeLocalHistory', err);
    }
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// --- HTTP ---

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Usage aggregation ---

// A turn makes multiple billed API calls, each written to the transcript several times
// as streaming artifacts sharing one `message.id` (output_tokens grows until the final
// artifact) — dedupe by `message.id` (last wins) BEFORE summing per model, or raw-line
// summing double-counts input/cache totals by the snapshot count.
//
// The final call's last artifact can persist non-finalized (`stop_reason === null`,
// stale `output_tokens`). If `finalizedUsage` is supplied (authoritative usage of the
// final call), it replaces the last message's usage iff that message is non-finalized.
//
// The advisor (`/advisor`) runs server-side inside one main-agent API call, billed to its
// own model but absent from the flat `message.usage` — its tokens live only in
// `message.usage.iterations[]` as `advisor_message` entries with their own `model`,
// so we walk `iterations` and attribute each to its model (see ADR-011).
//
// Returns Map<model, { usage, timestamp, ids }>; ids are the deduped message.ids that
// contributed, used to build the deterministic idempotency key.
function aggregateUsage(lines, startIdx = 0, finalizedUsage = null) {
  const byId = new Map();
  for (let i = startIdx; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!isCountableAssistant(entry)) {
        continue;
      }
      byId.set(entry.message.id, entry);
    } catch {
      continue;
    }
  }

  // The chronologically final call is the last-inserted message.id (a new id appears
  // only after the previous call's first artifact).
  let lastId = null;
  for (const id of byId.keys()) {
    lastId = id;
  }

  const byModel = new Map();
  const accFor = model => {
    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
        timestamp: null,
        ids: [],
        // Set only for advisor accumulators (see below) — null means "caller decides"
        // (writeAggregatedEntries falls back to the turn/subagent-level type).
        type: null,
      };
      byModel.set(model, acc);
    }
    return acc;
  };
  const addUsage = (acc, u, timestamp, id) => {
    acc.usage.input_tokens += u.input_tokens ?? 0;
    acc.usage.output_tokens += u.output_tokens ?? 0;
    acc.usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    acc.usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    // Per-TTL cache-write breakdown, flattened as siblings rather than nested (ADR-014).
    acc.usage.ephemeral_5m_input_tokens += u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    acc.usage.ephemeral_1h_input_tokens += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    acc.timestamp = timestamp ?? acc.timestamp;
    acc.ids.push(id);
  };

  for (const [id, entry] of byId) {
    const stale = entry.message.stop_reason === null;
    const u = (finalizedUsage && id === lastId && stale) ? finalizedUsage : entry.message.usage;
    addUsage(accFor(entry.message.model), u, entry.timestamp, id);

    // Read from the entry's own usage, not the possibly-substituted finalizedUsage
    // (a flat repair value with no iterations). Attributing to the parent message.id
    // keeps entryId stable — a different model namespaces the id set.
    for (const it of entry.message.usage.iterations ?? []) {
      if (it.type === 'advisor_message' && it.model) {
        const advisorAcc = accFor(it.model);
        addUsage(advisorAcc, it, entry.timestamp, id);
        advisorAcc.type = ADVISOR_TYPE;
      }
    }
  }
  return byModel;
}

// `type` classifies who was at work for a captured row — a main-turn skill invocation, a
// plain main-turn, a subagent's own kind, or the advisor. Local-history-only, like
// project/branch: never sent to the queue/backend.
//
// - Main-turn rows: a user-typed slash command that invoked a Skill wraps the turn-origin
//   entry's `message.content` (a plain string) in `<command-name>/xxx</command-name>`
//   (observed behavior, not documented by Claude Code). Only present when the user typed
//   the command themselves — a Skill the agent invokes mid-turn via its own tool call does
//   NOT produce this wrapper, so the two stay distinguishable. Falls back to MAIN_AGENT_TYPE.
// - Subagent rows: `hookData.agent_type` from the SubagentStop hook payload (the
//   subagent's `name`, e.g. "Explore", "code-reviewer", a custom name) — falls back to
//   SUBAGENT_TYPE only if that field is missing/empty (should not normally happen).
// - Advisor rows: the advisor runs inline in one main-turn API call, never through
//   SubagentStop, so it gets no `agent_type` — tagged ADVISOR_TYPE directly in
//   aggregateUsage instead (see below), since it's identifiable there by
//   `iterations[].type === 'advisor_message'`.
const MAIN_AGENT_TYPE = 'main-agent';
const SUBAGENT_TYPE = 'subagent';
const ADVISOR_TYPE = 'advisor';
const COMMAND_NAME_RE = /<command-name>\/([^<\n]+)<\/command-name>/;

function detectSkillType(originEntry) {
  const content = originEntry?.message?.content;
  if (typeof content !== 'string') {
    return null;
  }
  return content.match(COMMAND_NAME_RE)?.[1] ?? null;
}

// Deterministic idempotency key: the same turn re-captured produces the identical key,
// so the endpoint can drop duplicates. Sorted so ordering can never affect the hash.
function entryId(sessionId, model, ids) {
  const key = `${sessionId}|${model}|${[...ids].sort().join(',')}`;
  return crypto.createHash('sha1').update(key).digest('hex');
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
// failure all fall back to `null` (never throws, same principle as writeLocalHistory
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

// Aggregate `lines` from `startIdx` and write one queue entry per model. Shared by the
// Stop and SubagentStop paths so entry shape and idempotency-key derivation stay identical.
// `localHistory` gates the additional local.sqlite write — false by default so each capture
// path opts in individually as it's wired.
// `cwd` (the hook payload's own `cwd`, i.e. the session's working directory) is only ever
// used for local.sqlite-only columns — never sent to the queue/backend. `type` is the
// caller-determined default (MAIN_AGENT_TYPE, a skill name, or a subagent's agent_type) —
// overridden per-model by aggregateUsage's own ADVISOR_TYPE tag, since one aggregation
// window can hold both a main-turn model and an advisor model.
function writeAggregatedEntries(sessionId, lines, startIdx = 0, { cwd = null, type = null } = {}) {
  // Read once per call, not once per model — effectivePriceTable() re-reads prices.json.
  const priceTable = effectivePriceTable();
  const project = detectProject(cwd);
  const gitProject = detectGitProject(cwd);
  const branch = detectBranch(cwd);
  for (const [model, { usage, timestamp, ids, type: advisorType }] of aggregateUsage(lines, startIdx)) {
    const entry = {
      entry_id: entryId(sessionId, model, ids),
      timestamp: timestamp ?? new Date().toISOString(),
      session_id: sessionId,
      model,
      usage,
    };
    writeEntry(entry);
    writeLocalHistory({
      ...entry,
      price_cents: priceCentsForModel(model, usage, priceTable),
      project,
      git_project: gitProject,
      branch,
      type: advisorType ?? type,
    });
  }
}

// Read a JSONL transcript into non-empty lines, or null if transiently unreadable/vanished.
// Returning null (not throwing) keeps poll loops TOCTOU-safe — callers retry and keep
// their last good `lines` instead of a dropped entry.
function readTranscriptLines(transcriptPath) {
  try {
    return fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

// --- Finalization helpers (shared by both capture paths) ---

// stop_reasons marking a turn's TRUE final assistant message. This must be an ALLOWLIST,
// not a "truthy and not tool_use" denylist — a denylist wrongly accepts pause_turn
// (mid-turn, SDK resumes after) and would drop the resumed continuation's calls (ADR-013).
const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

function isTerminalStop(stopReason) {
  return TERMINAL_STOP_REASONS.has(stopReason);
}

// An assistant entry `aggregateUsage` will actually count. Shared with the finalization
// scans below — otherwise a poll could return early on an entry aggregation then drops
// (e.g. terminal but missing message.id), losing the turn (ADR-013).
function isCountableAssistant(entry) {
  return entry?.type === 'assistant'
    && !!entry.message?.usage
    && !!entry.message?.model
    && !!entry.message?.id;
}

// A `type: 'user'` entry that is the human's real prompt (not a tool_result, also
// `type: 'user'`). Shared by capture()'s backward scan and SessionEnd catch-up (ADR-015) —
// a diverging definition would drift catch-up's entryId from Stop's, defeating dedup.
function isTurnOriginEntry(entry) {
  if (entry?.type !== 'user') {
    return false;
  }
  const content = entry.message?.content;
  const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');
  return !isToolResult;
}

// Returns the CHRONOLOGICALLY LAST countable assistant entry, or null. Must be "last", not
// "any trailing finalized" — a multi-step turn's earlier calls can finalize while the
// final (largest) call is still a stale snapshot (see ADR-013).
function lastCountableAssistant(lines, startIdx = 0) {
  for (let i = lines.length - 1; i >= startIdx; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (isCountableAssistant(entry)) {
        return entry;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// --- Capture (Stop hook) ---

async function capture(hookData) {
  const { transcript_path: transcriptPath, session_id: sessionId, cwd = process.cwd() } = hookData;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return;
  }

  // The Stop hook fires before the final assistant entry is written — poll briefly for a
  // *finalized* entry (isTerminalStop on the chronologically last countable assistant),
  // not merely a present one, and fall back to the last snapshot rather than dropping the
  // turn if nothing terminal appears. Short window (~1s) since the main agent's final
  // message finalizes almost immediately — it's what triggered Stop (see ADR-013).
  let lines = [], turnStartIdx = 0, last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 200));
    }

    // Retry on transient read failure; `lines` keeps the last successful read.
    const read = readTranscriptLines(transcriptPath);
    if (!read) {
      continue;
    }
    lines = read;

    // The last 'user' entry marks where the turn's final assistant response begins.
    turnStartIdx = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        if (JSON.parse(lines[i]).type === 'user') {
          turnStartIdx = i + 1;
          break;
        }
      } catch {
        continue;
      }
    }

    // Is the turn's final assistant entry present, and has it reached a terminal stop yet?
    const found = lastCountableAssistant(lines, turnStartIdx);
    if (found) {
      last = found;
    }
    if (last && isTerminalStop(last.message.stop_reason)) {
      break;
    }
  }

  if (!last) {
    return;
  }

  // The turn starts at its original user prompt (scanning back to the first entry whose
  // content is NOT a tool_result). Subagent usage is deliberately NOT captured here — it's
  // captured from the dedicated SubagentStop hook instead (see ADR-013).
  let turnOriginIdx = 0;
  for (let i = turnStartIdx - 1; i >= 0; i--) {
    try {
      if (isTurnOriginEntry(JSON.parse(lines[i]))) {
        turnOriginIdx = i;
        break;
      }
    } catch {
      continue;
    }
  }

  let originEntry = null;
  try {
    originEntry = JSON.parse(lines[turnOriginIdx]);
  } catch {
    // leave null — detectSkillType(null) returns null, falling back to MAIN_AGENT_TYPE below
  }
  writeAggregatedEntries(sessionId, lines, turnOriginIdx, {
    cwd,
    type: detectSkillType(originEntry) ?? MAIN_AGENT_TYPE,
  });
}

// --- Catch-up (SessionEnd re-aggregation) ---
//
// `Stop` never fires on a user interrupt or a denied tool permission, so an aborted
// turn's tokens never reach capture() at all. At SessionEnd, before flushing, re-aggregate
// the transcript's trailing turns and (re-)write an entry for each — a turn Stop already
// captured produces the IDENTICAL entryId, so the server's existing dedup no-ops the
// resend; turns that never got a Stop event are queued for the first time (ADR-015).

// Segment `lines` into turn-origin boundaries, restricted to entries whose own sessionId
// matches (defensive against a transcript ever spanning two sessions).
function findTurnOrigins(lines, sessionId) {
  const origins = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.sessionId && entry.sessionId !== sessionId) {
        continue;
      }
      if (isTurnOriginEntry(entry)) {
        origins.push(i);
      }
    } catch {
      continue;
    }
  }
  return origins;
}

// Only trailing turns can be un-captured (older turns were already flushed) — this bound
// keeps SessionEnd's re-send volume small; it's a cost bound, not a correctness requirement.
const CATCH_UP_MAX_TURNS = 20;

async function catchUpCapture(hookData) {
  const { transcript_path: transcriptPath, session_id: sessionId, cwd = process.cwd() } = hookData;
  if (!transcriptPath || !sessionId) {
    return;
  }
  const lines = readTranscriptLines(transcriptPath);
  if (!lines) {
    return;
  }

  const origins = findTurnOrigins(lines, sessionId).slice(-CATCH_UP_MAX_TURNS);
  for (let t = 0; t < origins.length; t++) {
    const start = origins[t];
    const end = t + 1 < origins.length ? origins[t + 1] : lines.length;
    let originEntry = null;
    try {
      originEntry = JSON.parse(lines[start]);
    } catch {
      // leave null — detectSkillType(null) returns null, falling back to MAIN_AGENT_TYPE below
    }
    writeAggregatedEntries(sessionId, lines.slice(start, end), 0, {
      cwd,
      type: detectSkillType(originEntry) ?? MAIN_AGENT_TYPE,
    });
  }
}

// --- Capture (SubagentStop hook) ---
//
// Fires once when a subagent (background or synchronous) completes, carrying its own
// `agent_transcript_path`. Unlike the main Stop path there is no `toolUseResult` repair
// source, so `readFinalizedLines` polls a generous window before falling back to the
// stale snapshot. Also fires spuriously for internal agents with no transcript file;
// the existence guard below drops those (see ADR-013).
async function captureSubagent(hookData) {
  const {
    agent_transcript_path: transcriptPath,
    session_id: sessionId,
    cwd = process.cwd(),
    agent_type: agentType,
  } = hookData;
  if (!transcriptPath || !sessionId || !fs.existsSync(transcriptPath)) {
    return;
  }

  const lines = await readFinalizedLines(transcriptPath);
  if (!lines) {
    return;
  }

  writeAggregatedEntries(sessionId, lines, 0, { cwd, type: agentType || SUBAGENT_TYPE });
}

// Poll until the chronologically last countable assistant entry reaches a TERMINAL
// stop_reason, then return all parsed lines. Shares `lastCountableAssistant`/
// `isTerminalStop` with the main Stop poll; only the window (~3s, wider than Stop's ~1s
// since there's no toolUseResult fallback here) and timeout behavior differ. On timeout,
// returns the fullest snapshot read rather than dropping the turn; null only if no
// countable assistant entry ever appears (see ADR-013).
async function readFinalizedLines(transcriptPath, attempts = 15, delayMs = 200) {
  let lastGoodLines = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    // Retry on transient read failure; a persistent one ends as null.
    const lines = readTranscriptLines(transcriptPath);
    if (!lines) {
      continue;
    }
    const last = lastCountableAssistant(lines, 0);
    // Transcript is append-only, so the newest read with a countable entry dominates
    // earlier ones — remember it as the timeout fallback, set before the terminal check
    // returns so a later throwing read can't discard salvaged content.
    if (last) {
      lastGoodLines = lines;
    }
    if (last && isTerminalStop(last.message.stop_reason)) {
      return lines;
    }
  }
  // Timed out without a terminal stop_reason — return the fullest snapshot read rather
  // than dropping the turn (accepted residual if the final call never landed, ADR-013).
  return lastGoodLines;
}

// --- Flush (SessionEnd hook) ---

async function flush() {
  const files = getQueueFiles();
  if (files.length === 0) {
    return;
  }
  // Base URL set at install time, no hardcoded default (ADR-016). Missing means an
  // install predating that requirement, or a corrupt config — fail closed, keep the queue.
  const apiBaseUrl = loadConfig().apiBaseUrl;
  if (!apiBaseUrl) {
    logError('flush', 'no API base URL configured in config.json — reinstall with --api-base-url <url>');
    return;
  }
  if (!acquireLock()) {
    return;
  }

  const remove = f => {
    try {
      fs.rmSync(f);
    } catch {}
  };

  try {
    // Drop entries that have outlived MAX_QUEUE_AGE_MS (e.g. the endpoint has been
    // unreachable for weeks) so the queue can't grow without bound, then process the
    // rest oldest-first (filename is enqueue-time-prefixed).
    const now = Date.now();
    const snapshot = files
      .filter(f => {
        const t = enqueueTime(f);
        if (t !== null && now - t > MAX_QUEUE_AGE_MS) {
          logError('flush', `dropping stale entry ${path.basename(f)}`);
          remove(f);
          return false;
        }
        return true;
      })
      .sort();

    // Read once up front rather than per batch — both are constant for the whole flush.
    const userId = getUserId();
    const pluginVersion = loadConfig().currentVersion;

    // Send in bounded batches: each batch is deleted only after the server accepts it
    // (2xx) or permanently rejects it (a 4xx that isn't 408/429), so one bad or
    // oversized batch can neither block nor be retried forever — the rest of the queue
    // stays intact and is retried next session.
    for (let i = 0; i < snapshot.length; i += FLUSH_BATCH_SIZE) {
      const batch = snapshot.slice(i, i + FLUSH_BATCH_SIZE);
      const entries = [];
      for (const f of batch) {
        try {
          entries.push(JSON.parse(fs.readFileSync(f, 'utf8')));
        } catch {
          // Unparseable (half-written by a concurrent hook, or a SIGKILL remnant) —
          // omit from the payload; it's cleared with the batch on success, or by the
          // age prune above once it's old enough.
        }
      }
      if (entries.length === 0) {
        continue;
      }

      const res = await fetchWithTimeout(rawUrl(apiBaseUrl, INGEST_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, plugin_version: pluginVersion, prompts: entries }),
      });

      const remaining = snapshot.length - i;
      if (!res) {
        logError('flush', `network error — ${remaining} entries remain in queue`);
        return;
      }
      if (res.ok) {
        batch.forEach(remove);
        continue;
      }
      // A 4xx means the server will never accept this payload — drop it, except the
      // reachability codes (401/403/408/429), which can mean "off-VPN", not "rejected" (ADR-005).
      const TRANSIENT_4XX = new Set([401, 403, 408, 429]);
      const permanent = res.status >= 400 && res.status < 500 && !TRANSIENT_4XX.has(res.status);
      if (permanent) {
        logError('flush', `HTTP ${res.status} — dropping ${entries.length} rejected entries`);
        batch.forEach(remove);
        continue;
      }
      // 5xx / 401 / 403 / 408 / 429: transient — keep the rest of the queue and retry next session.
      logError('flush', `HTTP ${res.status} — ${remaining} entries remain in queue`);
      return;
    }
  } finally {
    releaseLock();
  }
}

// --- Price fetch (own weekly cadence) ---
//
// Fetches the plugin's current price table and caches it as prices.json; statusline.js
// reads the cache at render time (never over the network), falling back to its hardcoded
// default table per model on missing/invalid entries (see ADR-017). A
// missing/unreachable/malformed response is a silent no-op, retried next --check-update.

// Maps the response's field names to this plugin's internal short names (ADR-017).
const PRICE_FIELD_MAP = {
  inputCentPerMillion: 'input',
  outputCentPerMillion: 'output',
  cacheWriteCentPerMillion: 'cacheWriteGeneric',
  cacheReadCentPerMillion: 'cacheRead',
  cacheWrite5mCentPerMillion: 'cacheWrite5m',
  cacheWrite1hCentPerMillion: 'cacheWrite1h',
};

// Validates and remaps one model's price entry from response field names to internal ones.
// Returns null if any of the six required fields is missing or not a finite, non-negative
// number — the caller drops such entries individually rather than failing the whole table.
function sanitizePriceEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const out = {};
  for (const [srcField, destField] of Object.entries(PRICE_FIELD_MAP)) {
    const n = raw[srcField];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      return null;
    }
    out[destField] = n;
  }
  return out;
}

// Validates a whole response body (flat, model-keyed, no wrapper — see ADR-017). Drops
// individually-invalid model entries; returns null only if nothing in the response validated,
// so the caller never overwrites a previously-good cache with an empty one.
function sanitizePriceTable(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const table = {};
  for (const [model, entry] of Object.entries(raw)) {
    const sanitized = sanitizePriceEntry(entry);
    if (sanitized) {
      table[model] = sanitized;
    }
  }
  return Object.keys(table).length > 0 ? table : null;
}

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

// --- Price lookup for local history (capture-time, not statusline's render-time copy) ---
//
// Duplicated from statusline.js rather than shared (ADR-012: hook.js and statusline.js
// never require() each other, since pluginFiles auto-update per-file, not in lockstep).
// Used to fill local.sqlite's price_cents at capture time — the queue/backend payload is
// unaffected, price there is computed server-side.

// Anthropic list prices, cents per million tokens; hardcoded default, overridable per
// model by the cached table (see ADR-017). Keep in sync with statusline.js's own copy.
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
// sanitizePriceTable/fetchPrices) — same fields, distinct name from sanitizePriceEntry above,
// which validates the RAW fetch response's long field names instead.
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

async function fetchPrices(fetchFn = fetchWithTimeout) {
  const config = loadConfig();
  if (!config.currentVersion || !config.apiBaseUrl) {
    return; // not installed, or raced with an uninstall clearing config.json
  }
  const res = await fetchFn(rawUrl(config.apiBaseUrl, PRICES_ROUTE), {}, TIMEOUT_MS);
  if (!res?.ok) {
    // unreachable, or no price route on this backend — fetchedAt stamps only on success,
    // so an unstamped/stale cache means checkUpdate() retries next session
    return;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return;
  }
  const table = sanitizePriceTable(body);
  if (!table) {
    return;
  }
  ensurePluginDir();
  atomicWriteSync(PRICES_CACHE_PATH, JSON.stringify({
    schema: PRICE_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    table,
  }, null, 2));
}

// --- Loader (SessionStart hook) — runs synchronously, exits fast ---
//
// hook.js contains no update logic itself; the loader fetches updater.js fresh and runs
// it, so an update bug is fixed server-side next session instead of stranding an install
// (see ADR-012). This minimal loader is the only permanently-frozen update code.

function spawnBackground(mode) {
  const child = spawn(process.execPath, [__filename, mode], { detached: true, stdio: 'ignore' });
  child.unref();
}

// spawnFn / selfPath are seams for tests; production uses spawnBackground and __filename.
function checkUpdate(spawnFn = spawnBackground, selfPath = __filename) {
  // Always flush on session start to catch entries from sessions that didn't end cleanly.
  spawnFn('--flush');

  const config = loadConfig();
  if (!config.currentVersion) {
    return;
  }

  // Independent of the code-update throttle below — its own cadence, own state file (ADR-017).
  const prices = loadPricesCache();
  const lastPriceFetch = prices.fetchedAt ? new Date(prices.fetchedAt) : null;
  const priceThrottled = lastPriceFetch && (Date.now() - lastPriceFetch.getTime()) < PRICE_UPDATE_INTERVAL_MS;
  if (!priceThrottled) {
    spawnFn('--fetch-prices');
  }

  // Running from a non-canonical path means the install isn't migrated yet — force an
  // immediate update rather than waiting up to 24h. Compare via realpath so a symlinked
  // ~/.claude doesn't make selfPath !== HOOK_DEST forever; falls back to the raw path
  // when the target doesn't exist yet (migration).
  const realOf = p => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const migrationPending = realOf(selfPath) !== realOf(HOOK_DEST);

  // A pending migration normally bypasses the throttle, but once converge has recorded
  // migrationBlocked (remote rolled back older), don't — or every session spawns a fresh
  // --update. converge clears the flag once the remote is no longer older (see ADR-012).
  const forceMigration = migrationPending && !config.migrationBlocked;

  // lastUpdateCheck is written by converge (inside updater.js) after a successful server
  // contact, so a failed check (e.g. VPN off) is retried next session, not throttled 24h.
  const lastCheck = config.lastUpdateCheck ? new Date(config.lastUpdateCheck) : null;
  const throttled = lastCheck && (Date.now() - lastCheck.getTime()) < UPDATE_INTERVAL_MS;
  if (!forceMigration && throttled) {
    return;
  }

  spawnFn('--update');
}

// --- Update (detached background process) — fetch updater.js and run it via stdin ---

async function updateFromRemote(runFn = runUpdaterSource) {
  if (!loadConfig().currentVersion) {
    return;
  }
  const base = loadConfig().repoRawBaseUrl;
  if (!base) {
    return; // No update source configured — never touch anything (see ADR-016).
  }
  const res = await fetchWithTimeout(rawUrl(base, 'updater.js'), {}, 10000);
  if (!res?.ok) {
    return;
  }
  let source;
  try {
    source = await res.text();
  } catch {
    return;
  }
  if (source.trimStart().startsWith('<!')) {
    return; // HTML error page, not source
  }
  runFn(source);
}

// Pipe the fetched updater source to a fresh `node -` process — nothing written to disk,
// sidesteps noexec mounts, no external tools needed (see ADR-012).
function runUpdaterSource(source) {
  const child = spawn(process.execPath, ['-'], {
    env: { ...process.env, TUP_MODE: 'converge' },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  child.on('error', () => {}); // e.g. spawn failure — nothing to do in a background hook
  child.stdin.on('error', () => {}); // swallow EPIPE if the child exits early
  child.stdin.write(source);
  child.stdin.end();
  child.unref();
}

// --- Main ---

async function main() {
  const mode = process.argv[2];

  if (mode === '--check-update') {
    checkUpdate();
    return;
  }
  if (mode === '--update') {
    await updateFromRemote();
    return;
  }
  if (mode === '--fetch-prices') {
    await fetchPrices();
    return;
  }
  if (mode === '--flush') {
    const hookData = await readStdinJson();
    try {
      await catchUpCapture(hookData);
    } catch (err) {
      logError('catchUpCapture', err);
    }
    await flush();
    return;
  }
  if (mode === '--subagent-stop') {
    await captureSubagent(await readStdinJson());
    return;
  }
  // Any other flag (e.g. a stray --do-update spawned by a frozen 0.3.5 process mid-upgrade)
  // is a no-op — only the argument-less invocation is the capture (Stop) hook.
  if (mode?.startsWith('--')) {
    return;
  }

  await capture(await readStdinJson());
}

// Read the hook payload from stdin and parse it; malformed input yields {} so a bad
// payload is a no-op rather than a crash.
async function readStdinJson() {
  let payload = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    payload += chunk;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

if (require.main === module) {
  main().catch(err => {
    logError('main', err);
    process.exit(0);
  });
}

module.exports = {
  atomicWriteSync,
  getUserId,
  loadConfig,
  writeEntry,
  getQueueFiles,
  openLocalHistoryDb,
  writeLocalHistory,
  isMissingSqliteModule,
  detectProject,
  detectGitProject,
  detectBranch,
  resolveBaseWorktree,
  writeAggregatedEntries,
  LOCAL_HISTORY_DB_PATH,
  FLUSH_BATCH_SIZE,
  acquireLock,
  releaseLock,
  isProcessAlive,
  aggregateUsage,
  entryId,
  capture,
  captureSubagent,
  readFinalizedLines,
  isTurnOriginEntry,
  catchUpCapture,
  flush,
  checkUpdate,
  updateFromRemote,
  fetchPrices,
  sanitizePriceTable,
  sanitizePriceEntry,
  sanitizeCachedPriceEntry,
  PRICE_TABLE,
  matchPriceKey,
  priceMicroCentsForModel,
  effectivePriceTable,
  priceCentsForModel,
  PRICES_CACHE_PATH,
  PRICE_SCHEMA_VERSION,
  PRICE_UPDATE_INTERVAL_MS,
  INGEST_PATH,
  PRICES_ROUTE,
  HOOK_DEST,
  MAIN_AGENT_TYPE,
  SUBAGENT_TYPE,
  ADVISOR_TYPE,
  detectSkillType,
};
