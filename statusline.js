#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mirrors hook.js's config-dir resolution but deliberately does NOT require('./hook.js'):
// both files are pluginFiles that auto-update per-file, not in lockstep, so each must run
// correctly against a version-mismatched sibling (see ADR-012).
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'token-usage-plugin');
const QUEUE_DIR = path.join(PLUGIN_DIR, 'queue');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
// Cached price table written by hook.js's weekly --fetch-prices (ADR-017); read-only here.
// schema guards against reading a cache written by a hook.js one converge ahead of us.
const PRICES_CACHE_PATH = path.join(PLUGIN_DIR, 'prices.json');
const PRICE_SCHEMA_VERSION = 1;

// Anthropic list prices, cents per million tokens; hardcoded default, overridable per
// model by the cached table (see ADR-017). Source of truth: .claude/claude_prices.csv —
// update both together. cacheWrite5m/cacheWrite1h are the ADR-014 TTL-specific rates;
// cacheWriteGeneric is the fallback for tokens not attributable to either bucket.
const PRICE_TABLE = {
  fable: { input: 1000, output: 5000, cacheWriteGeneric: 1250, cacheRead: 100, cacheWrite5m: 1250, cacheWrite1h: 2000 },
  opus: { input: 500, output: 2500, cacheWriteGeneric: 625, cacheRead: 50, cacheWrite5m: 625, cacheWrite1h: 1000 },
  sonnet: { input: 200, output: 1000, cacheWriteGeneric: 250, cacheRead: 20, cacheWrite5m: 250, cacheWrite1h: 400 },
  haiku: { input: 100, output: 500, cacheWriteGeneric: 125, cacheRead: 10, cacheWrite5m: 125, cacheWrite1h: 200 },
};

// Backlog older than this is no longer "waiting for the next SessionEnd flush" —
// it means the endpoint has been unreachable across multiple sessions.
const STALE_QUEUE_MS = 24 * 60 * 60 * 1000;
// A logged error inside this window is still relevant to today's session.
const ERROR_RECENCY_MS = 15 * 60 * 1000;

// --- Token count (informational — how much this session has used so far) ---

// Only the main transcript is available here — no reliable way to find a subagent's own
// transcript at render time — so this is a main-agent total, not a billing-accurate
// whole-session figure. Advisor usage (ADR-011) IS included (nested in the main
// transcript's own `usage.iterations[]`). Subagent tokens are never in this total; their
// presence is detected (an `Agent` tool_use block) and flags the total `incomplete` rather
// than silently under-reporting.

// Longest (most specific) matching table key wins over insertion order — once `table` can
// mix fetched entries with PRICE_TABLE's own (ADR-017), a specific key like "sonnet-4-5"
// must win over generic "sonnet" regardless of order. null (not a default) when no key
// matches, so callers treat it as "price unknown", not zero-cost.
function matchPriceKey(model, table = PRICE_TABLE) {
  if (typeof model !== 'string') {
    return null;
  }
  const lower = model.toLowerCase();
  return Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find(key => lower.includes(key)) ?? null;
}

// Micro-cents (rate * tokens, not yet /1e6) for one model's usage — callers sum across
// models and divide once, so float error can't accumulate per-model. Cache-write tokens
// price by TTL bucket (ADR-014) where known; the remainder falls back to the generic rate.
// Returns null (not 0) on an unmatched model so callers can flag the total as a lower bound.
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

// Returns null on absent/unparseable/schema-mismatch so the caller falls back to PRICE_TABLE.
function loadCachedPriceTable() {
  try {
    const data = JSON.parse(fs.readFileSync(PRICES_CACHE_PATH, 'utf8'));
    if (data?.schema !== PRICE_SCHEMA_VERSION || typeof data.table !== 'object' || !data.table) {
      return null;
    }
    return data.table;
  } catch {
    return null;
  }
}

// Validates one cached entry against a fixed field allowlist (extra fields ignored, for
// forward-compat with a newer hook.js). Returns null on any missing/invalid field.
function sanitizePriceEntry(v) {
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

// Merges validated cached entries over PRICE_TABLE per model (ADR-017) — one bad entry must
// not regress every other, correctly-cached model back to hardcoded rates.
function effectivePriceTable() {
  const cached = loadCachedPriceTable();
  if (!cached) {
    return PRICE_TABLE;
  }
  const merged = { ...PRICE_TABLE };
  for (const [model, entry] of Object.entries(cached)) {
    const sanitized = sanitizePriceEntry(entry);
    if (sanitized) {
      merged[model] = sanitized;
    }
  }
  return merged;
}

// Mirrors hook.js's aggregateUsage (ADR-011/ADR-014): dedupe by message.id, fold in advisor
// iterations under their own model, group by model — models have different rates, so
// summing tokens first and pricing once would be wrong whenever a session mixes models.
function computeSessionTokens(transcriptPath, table = PRICE_TABLE) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { tokens: 0, incomplete: false, inputTokens: 0, outputTokens: 0, priceCents: 0 };
  }
  const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  const byId = new Map();
  let incomplete = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!incomplete && Array.isArray(entry.message?.content)) {
      incomplete = entry.message.content.some(b => b.type === 'tool_use' && b.name === 'Agent');
    }
    if (entry.type !== 'assistant' || !entry.message?.usage || !entry.message?.id) {
      continue;
    }
    byId.set(entry.message.id, entry.message);
  }

  const byModel = new Map();
  const accFor = model => {
    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
      };
      byModel.set(model, acc);
    }
    return acc;
  };
  const addUsage = (acc, u) => {
    acc.input_tokens += u.input_tokens ?? 0;
    acc.output_tokens += u.output_tokens ?? 0;
    acc.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    acc.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    acc.ephemeral_5m_input_tokens += u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    acc.ephemeral_1h_input_tokens += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  };

  for (const message of byId.values()) {
    addUsage(accFor(message.model), message.usage);
    for (const it of message.usage.iterations ?? []) {
      if (it.type === 'advisor_message' && it.model) {
        addUsage(accFor(it.model), it);
      }
    }
  }

  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let priceMicroCents = 0;
  for (const [model, u] of byModel) {
    inputTokens += u.input_tokens;
    outputTokens += u.output_tokens;
    tokens += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    const micro = priceMicroCentsForModel(model, u, table);
    if (micro === null) {
      incomplete = true;
    } else {
      priceMicroCents += micro;
    }
  }
  return { tokens, incomplete, inputTokens, outputTokens, priceCents: priceMicroCents / 1e6 };
}

// currentVersion is stamped into config.json by the updater (ADR-012) — read directly,
// same self-containment rule as the rest of this file.
function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).currentVersion ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Hook health (does capture/send actually work) ---

function getQueueStatus(queueDir, now) {
  if (!fs.existsSync(queueDir)) {
    return { count: 0, oldestAgeMs: 0 };
  }
  const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  if (files.length === 0) {
    return { count: 0, oldestAgeMs: 0 };
  }
  let oldest = now;
  for (const f of files) {
    const n = parseInt(f, 10);
    if (!Number.isNaN(n) && n < oldest) {
      oldest = n;
    }
  }
  return { count: files.length, oldestAgeMs: now - oldest };
}

// error.log is only ever appended to by logError(), so its mtime is the last
// error time — no need to parse content.
function hasRecentError(logPath, now, thresholdMs) {
  if (!fs.existsSync(logPath)) {
    return false;
  }
  try {
    return (now - fs.statSync(logPath).mtimeMs) < thresholdMs;
  } catch {
    return false;
  }
}

// --- Model / context window ---

// Claude Code suffixes display_name with " (1M context)" / " (200K context)" when
// a model's context window differs from the default — strip it, we show usage separately.
function formatModelName(displayName) {
  if (!displayName || typeof displayName !== 'string') {
    return 'Unknown model';
  }
  return displayName.replace(/ *\((1M|200K) context\)/, '');
}

// Claude Code sends used_percentage as a number 0-100; guard against missing/non-numeric.
function normalizeUsedPct(usedPercentage) {
  const n = Number(usedPercentage);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

// --- Formatting ---

function formatProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function formatPct(pct) {
  const color = pct >= 80 ? '\x1b[31m' : pct >= 40 ? '\x1b[95m' : ''; // red/bright magenta/none
  const reset = color ? '\x1b[0m' : '';
  const text = pct >= 80 ? `${pct}% COMPACT!` : `${pct}%`;
  return `${color}${text}${reset}`;
}

// ANSI-colored ●
function dot(color) {
  const codes = { red: '\x1b[31m', none: '\x1b[0m', blue: '\x1b[34m' };
  return `${codes[color]}●\x1b[0m`;
}

function formatTokens(n) {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatAge(ms) {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return `${Math.max(hours, 1)}h`;
}

function buildStatusLine({
  tokens, incomplete, queue, recentError, modelName, contextPct,
  version, inputTokens, outputTokens, priceCents,
}) {
  const tok = `${incomplete ? '≥' : ''}${formatTokens(tokens)} token`;
  let syncSegment;
  if ((recentError && queue.count > 0) || queue.oldestAgeMs > STALE_QUEUE_MS) {
    const suffix = queue.count > 0 ? `${queue.count} queued, ${formatAge(queue.oldestAgeMs)}` : 'error sending';
    syncSegment = `${tok} · ${dot('red')} ${suffix}`;
  } else if (queue.count > 0) {
    syncSegment = `${tok} · ${dot('none')} ${queue.count} queued`;
  } else {
    syncSegment = `${tok} · ${dot('blue')} synced`;
  }

  const bar = formatProgressBar(contextPct);
  const pctDisplay = formatPct(contextPct);

  // Arrows follow the network RX/TX convention: ↑ = sent (input tokens, uploaded to the
  // API), ↓ = received (output tokens, downloaded from the API)
  const marker = incomplete ? '≥ ' : '';
  const priceLine = `token-usage-plugin v${version} · `
    + `${marker}${formatTokens(inputTokens)} ↑ / ${marker}${formatTokens(outputTokens)} ↓ · `
    + `${marker}${formatPrice(priceCents)}`;

  return `${modelName} · ${syncSegment} · context window: ${bar} ${pctDisplay} \n${priceLine}`;
}

// --- Main ---

async function main() {
  let payload = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    payload += chunk;
  }
  let input = {};
  try {
    input = JSON.parse(payload);
  } catch {
    // No input — still render a line from local plugin state alone.
  }

  const now = Date.now();
  const priceTable = effectivePriceTable();
  const { tokens, incomplete, inputTokens, outputTokens, priceCents } = computeSessionTokens(input.transcript_path, priceTable);
  const queue = getQueueStatus(QUEUE_DIR, now);
  const recentError = hasRecentError(LOG_PATH, now, ERROR_RECENCY_MS);
  const modelName = formatModelName(input.model?.display_name);
  const contextPct = normalizeUsedPct(input.context_window?.used_percentage);
  const version = readPluginVersion();
  process.stdout.write(buildStatusLine({
    tokens, incomplete, queue, recentError, modelName, contextPct,
    version, inputTokens, outputTokens, priceCents,
  }));
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('token-usage: error');
  });
}

module.exports = {
  computeSessionTokens,
  getQueueStatus,
  hasRecentError,
  formatTokens,
  formatAge,
  formatModelName,
  normalizeUsedPct,
  formatProgressBar,
  formatPct,
  formatPrice,
  dot,
  buildStatusLine,
  matchPriceKey,
  priceMicroCentsForModel,
  readPluginVersion,
  loadCachedPriceTable,
  effectivePriceTable,
  STALE_QUEUE_MS,
  ERROR_RECENCY_MS,
  PRICE_TABLE,
  PRICES_CACHE_PATH,
  PRICE_SCHEMA_VERSION,
};
