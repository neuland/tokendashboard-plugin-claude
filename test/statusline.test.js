'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
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
} = require('../statusline.js');
const { withTempHome, queueDir, errorLogPath, runStatuslineProcess, loadStatusline, inStatuslineSandbox, pricesPath } = require('./helpers.js');

// Build an assistant transcript line, mirroring aggregate.test.js's helper.
function assistant(id, usage = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  });
}

test('computeSessionTokens', async t => {
  await t.test('returns 0 (complete) when the transcript does not exist', () => {
    // given / when / then
    assert.deepEqual(
      computeSessionTokens('/nonexistent/path.jsonl'),
      { tokens: 0, incomplete: false, inputTokens: 0, outputTokens: 0, priceCents: 0 },
    );
  });

  await t.test('sums input/output/cache tokens across distinct billed calls', () => {
    // given — two separate billed calls
    const { home, cleanup } = withTempHome();
    const transcriptPath = path.join(home, 'transcript.jsonl');
    try {
      fs.writeFileSync(transcriptPath, [
        assistant('id-1', { input_tokens: 100, output_tokens: 10 }),
        assistant('id-2', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 5 }),
      ].join('\n'));

      // when
      const result = computeSessionTokens(transcriptPath);

      // then — all-sonnet: (300*200 + 30*1000 + 5*20) / 1e6 = 0.0901
      assert.deepEqual(result, {
        tokens: 335, incomplete: false, inputTokens: 300, outputTokens: 30, priceCents: 0.0901,
      });
    } finally {
      cleanup();
    }
  });

  await t.test('dedupes streaming artifacts sharing a message.id (last wins)', () => {
    // given — one billed call written twice as it streams; output_tokens grows
    const { home, cleanup } = withTempHome();
    const transcriptPath = path.join(home, 'transcript.jsonl');
    try {
      fs.writeFileSync(transcriptPath, [
        assistant('id-1', { input_tokens: 50, output_tokens: 5 }),
        assistant('id-1', { input_tokens: 50, output_tokens: 40 }),
      ].join('\n'));

      // when
      const result = computeSessionTokens(transcriptPath);

      // then — summing raw would give 145; deduped gives the last artifact only.
      // price: (50*200 + 40*1000) / 1e6 = 0.05
      assert.deepEqual(result, {
        tokens: 90, incomplete: false, inputTokens: 50, outputTokens: 40, priceCents: 0.05,
      });
    } finally {
      cleanup();
    }
  });

  await t.test('includes advisor usage nested in usage.iterations[]', () => {
    // given — a call whose flat usage covers only the executor, plus an advisor iteration
    const { home, cleanup } = withTempHome();
    const transcriptPath = path.join(home, 'transcript.jsonl');
    try {
      const entry = JSON.parse(assistant('id-1', { input_tokens: 100, output_tokens: 10 }));
      entry.message.usage.iterations = [
        { type: 'advisor_message', model: 'claude-opus-5', input_tokens: 300, output_tokens: 50 },
      ];
      fs.writeFileSync(transcriptPath, JSON.stringify(entry));

      // when
      const result = computeSessionTokens(transcriptPath);

      // then — 110 (executor, sonnet) + 350 (advisor, opus). price: sonnet (100*200+10*1000)
      // + opus (300*500+50*2500) = 30000 + 275000 = 305000 / 1e6 = 0.305
      assert.deepEqual(result, {
        tokens: 460, incomplete: false, inputTokens: 400, outputTokens: 60, priceCents: 0.305,
      });
    } finally {
      cleanup();
    }
  });

  await t.test('flags incomplete when a subagent (Agent tool_use) ran this session', () => {
    // given — a main-transcript assistant call plus an "Agent" tool_use block
    const { home, cleanup } = withTempHome();
    const transcriptPath = path.join(home, 'transcript.jsonl');
    try {
      fs.writeFileSync(transcriptPath, [
        assistant('id-1', { input_tokens: 100, output_tokens: 10 }),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'id-2', content: [{ type: 'tool_use', name: 'Agent', input: {} }] },
        }),
      ].join('\n'));

      // when
      const result = computeSessionTokens(transcriptPath);

      // then — main-agent total is still counted, but flagged as a lower bound.
      // price: (100*200 + 10*1000) / 1e6 = 0.030
      assert.deepEqual(result, {
        tokens: 110, incomplete: true, inputTokens: 100, outputTokens: 10, priceCents: 0.03,
      });
    } finally {
      cleanup();
    }
  });

  await t.test('flags incomplete when a model has no known price (cost would otherwise be silently 0)', () => {
    // given — a model string that matches none of PRICE_TABLE's keys
    const { home, cleanup } = withTempHome();
    const transcriptPath = path.join(home, 'transcript.jsonl');
    try {
      const entry = JSON.parse(assistant('id-1', { input_tokens: 100, output_tokens: 10 }));
      entry.message.model = 'some-future-model';
      fs.writeFileSync(transcriptPath, JSON.stringify(entry));

      // when
      const result = computeSessionTokens(transcriptPath);

      // then — tokens are still counted, but price is excluded and flagged as a lower bound
      assert.deepEqual(result, {
        tokens: 110, incomplete: true, inputTokens: 100, outputTokens: 10, priceCents: 0,
      });
    } finally {
      cleanup();
    }
  });
});

test('getQueueStatus', async t => {
  await t.test('reports empty when the queue dir does not exist', () => {
    // given / when / then
    assert.deepEqual(getQueueStatus('/nonexistent/queue', Date.now()), { count: 0, oldestAgeMs: 0 });
  });

  await t.test('counts entries and finds the oldest by filename timestamp prefix', () => {
    // given — a queue dir with three entries at known enqueue times, plus a lock file
    const { home, cleanup } = withTempHome();
    const dir = queueDir(home);
    const now = 1_000_000_000_000;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${now - 5000}-1-0.json`), '{}');
      fs.writeFileSync(path.join(dir, `${now - 60000}-1-1.json`), '{}');
      fs.writeFileSync(path.join(dir, `${now - 1000}-1-2.json`), '{}');
      fs.writeFileSync(path.join(dir, '.lock'), '1');

      // when
      const status = getQueueStatus(dir, now);

      // then — 3 counted (lock excluded), age measured from the oldest (60s ago)
      assert.equal(status.count, 3);
      assert.equal(status.oldestAgeMs, 60000);
    } finally {
      cleanup();
    }
  });
});

test('hasRecentError', async t => {
  await t.test('false when the log file does not exist', () => {
    // given / when / then
    assert.equal(hasRecentError('/nonexistent/error.log', Date.now(), 60000), false);
  });

  await t.test('true within the threshold, false once past it', () => {
    // given — an error.log last modified "now"
    const { home, cleanup } = withTempHome();
    const logPath = errorLogPath(home);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'boom\n');
      const mtime = fs.statSync(logPath).mtimeMs;

      // when / then
      assert.equal(hasRecentError(logPath, mtime + 1000, 60000), true);
      assert.equal(hasRecentError(logPath, mtime + 120000, 60000), false);
    } finally {
      cleanup();
    }
  });
});

test('formatTokens', () => {
  // given / when / then — thresholds at 1k and 1M
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_500_000), '2.5M');
});

test('formatAge', () => {
  // given / when / then
  assert.equal(formatAge(30 * 60 * 1000), '1h'); // sub-hour still shows "1h", never "0h"
  assert.equal(formatAge(5 * 60 * 60 * 1000), '5h');
  assert.equal(formatAge(3 * 24 * 60 * 60 * 1000), '3d');
});

test('formatModelName', () => {
  // given / when / then
  assert.equal(formatModelName('Claude Sonnet 5 (1M context)'), 'Claude Sonnet 5');
  assert.equal(formatModelName('Claude Sonnet 5 (200K context)'), 'Claude Sonnet 5');
  assert.equal(formatModelName('Claude Sonnet 5'), 'Claude Sonnet 5');
  assert.equal(formatModelName(undefined), 'Unknown model');
  assert.equal(formatModelName(''), 'Unknown model');
});

test('normalizeUsedPct', () => {
  // given / when / then
  assert.equal(normalizeUsedPct(42), 42);
  assert.equal(normalizeUsedPct(42.6), 43); // rounds
  assert.equal(normalizeUsedPct(undefined), 0);
  assert.equal(normalizeUsedPct('not-a-number'), 0);
  assert.equal(normalizeUsedPct(-5), 0); // clamps low
  assert.equal(normalizeUsedPct(150), 100); // clamps high
});

test('dot', () => {
  // given / when / then — ANSI-wrapped ●, 'none' means no color code (dimmed)
  assert.equal(dot('red'), '\x1b[31m●\x1b[0m');
  assert.equal(dot('blue'), '\x1b[34m●\x1b[0m');
  assert.equal(dot('none'), '\x1b[0m●\x1b[0m');
});

test('formatProgressBar', () => {
  // given / when / then — 10 blocks total, no color (plain filled/empty blocks)
  assert.equal(formatProgressBar(0), '░░░░░░░░░░');
  assert.equal(formatProgressBar(100), '▓▓▓▓▓▓▓▓▓▓');
  assert.equal(formatProgressBar(42), '▓▓▓▓░░░░░░'); // round(4.2) = 4 filled
  assert.equal(formatProgressBar(45), '▓▓▓▓▓░░░░░'); // round(4.5) = 5 filled
});

test('formatPct', () => {
  // given / when / then — no color <40%, bright magenta 40-79%, red + "COMPACT!" at 80%+
  assert.equal(formatPct(0), '0%');
  assert.equal(formatPct(39), '39%');
  assert.equal(formatPct(40), '\x1b[95m40%\x1b[0m');
  assert.equal(formatPct(79), '\x1b[95m79%\x1b[0m');
  assert.equal(formatPct(80), '\x1b[31m80% COMPACT!\x1b[0m');
  assert.equal(formatPct(100), '\x1b[31m100% COMPACT!\x1b[0m');
});

test('formatPrice', () => {
  // given / when / then
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(formatPrice(45150), '$451.50');
  assert.equal(formatPrice(4.5), '$0.04'); // rounds
});

test('matchPriceKey', () => {
  // given / when / then — substring match, case-insensitive, unknown model -> null
  assert.equal(matchPriceKey('claude-sonnet-5-20250514'), 'sonnet');
  assert.equal(matchPriceKey('claude-opus-5'), 'opus');
  assert.equal(matchPriceKey('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(matchPriceKey('claude-fable-5'), 'fable');
  assert.equal(matchPriceKey('CLAUDE-SONNET-5'), 'sonnet');
  assert.equal(matchPriceKey('some-unknown-model'), null);
  assert.equal(matchPriceKey(undefined), null);
});

test('priceMicroCentsForModel', () => {
  // given — usage with a cache-write split across both TTL buckets plus an unattributed remainder
  const u = {
    input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 30, ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10,
  };

  // when / then — unknown model returns null (not 0), so callers can flag price-unknown
  // rather than silently under-pricing it as free
  assert.equal(priceMicroCentsForModel('some-unknown-model', u), null);

  // sonnet: 1000*200 + 100*1000 + 10*250 (5m) + 10*400 (1h) + 10*250 (unattributed remainder) + 50*20
  // = 200000 + 100000 + 2500 + 4000 + 2500 + 1000 = 465000 (still in micro-cents, undivided)
  assert.equal(priceMicroCentsForModel('claude-sonnet-5', u), 310000);
});

test('matchPriceKey prefers the longer (more specific) key over table insertion order', () => {
  // given — a table where a generic key was inserted before a more specific one that is
  // itself a substring match candidate for the same model id (see ADR-017: once the table
  // can include fetched entries, insertion order can no longer be relied on)
  const table = { sonnet: {}, 'sonnet-4-5': {} };

  // when / then — the longer key wins regardless of which was inserted first
  assert.equal(matchPriceKey('claude-sonnet-4-5-20250929', table), 'sonnet-4-5');
  assert.equal(matchPriceKey('claude-sonnet-5', table), 'sonnet');
});

test('priceMicroCentsForModel resolves a model that exists only in a passed-in table', () => {
  // given — a table entry absent from the hardcoded default PRICE_TABLE
  const table = { 'my-custom-model': {
    input: 10, output: 20, cacheWriteGeneric: 5, cacheRead: 1, cacheWrite5m: 5, cacheWrite1h: 8,
  } };
  const u = {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
  };

  // when / then — resolves against the passed table, not the default (would be null otherwise)
  assert.equal(priceMicroCentsForModel('my-custom-model', u, table), 1000 + 200);
});

test('loadCachedPriceTable / effectivePriceTable', async t => {
  await t.test('falls back to the hardcoded PRICE_TABLE when prices.json is absent', () => {
    inStatuslineSandbox(statusline => {
      // given — no prices.json at all

      // when / then
      assert.equal(statusline.loadCachedPriceTable(), null);
      assert.deepEqual(statusline.effectivePriceTable(), statusline.PRICE_TABLE);
    });
  });

  await t.test('falls back when prices.json is unparseable', () => {
    inStatuslineSandbox((statusline, home) => {
      // given — a corrupt cache file
      fs.mkdirSync(path.dirname(pricesPath(home)), { recursive: true });
      fs.writeFileSync(pricesPath(home), 'not json {');

      // when / then
      assert.equal(statusline.loadCachedPriceTable(), null);
      assert.deepEqual(statusline.effectivePriceTable(), statusline.PRICE_TABLE);
    });
  });

  await t.test('falls back when the cache schema is not recognized', () => {
    inStatuslineSandbox((statusline, home) => {
      // given — a cache written by a future/incompatible hook.js
      fs.mkdirSync(path.dirname(pricesPath(home)), { recursive: true });
      fs.writeFileSync(pricesPath(home), JSON.stringify({
        schema: statusline.PRICE_SCHEMA_VERSION + 1,
        fetchedAt: new Date().toISOString(),
        table: { sonnet: { input: 1 } },
      }));

      // when / then
      assert.equal(statusline.loadCachedPriceTable(), null);
      assert.deepEqual(statusline.effectivePriceTable(), statusline.PRICE_TABLE);
    });
  });

  await t.test('merges valid cached entries over the hardcoded table, per model', () => {
    inStatuslineSandbox((statusline, home) => {
      // given — a valid cache overriding sonnet's rates and adding a new model
      fs.mkdirSync(path.dirname(pricesPath(home)), { recursive: true });
      fs.writeFileSync(pricesPath(home), JSON.stringify({
        schema: statusline.PRICE_SCHEMA_VERSION,
        fetchedAt: new Date().toISOString(),
        table: {
          sonnet: { input: 999, output: 999, cacheWriteGeneric: 999, cacheRead: 999, cacheWrite5m: 999, cacheWrite1h: 999 },
          'brand-new-model': { input: 1, output: 2, cacheWriteGeneric: 3, cacheRead: 4, cacheWrite5m: 5, cacheWrite1h: 6 },
        },
      }));

      // when
      const table = statusline.effectivePriceTable();

      // then — sonnet overridden, new model added, other hardcoded entries (e.g. opus) untouched
      assert.equal(table.sonnet.input, 999);
      assert.deepEqual(table['brand-new-model'], { input: 1, output: 2, cacheWriteGeneric: 3, cacheRead: 4, cacheWrite5m: 5, cacheWrite1h: 6 });
      assert.deepEqual(table.opus, statusline.PRICE_TABLE.opus);
    });
  });

  await t.test('a malformed cached entry falls back to the hardcoded default for that model only', () => {
    inStatuslineSandbox((statusline, home) => {
      // given — sonnet's cached entry is missing a required field; haiku's is valid
      fs.mkdirSync(path.dirname(pricesPath(home)), { recursive: true });
      fs.writeFileSync(pricesPath(home), JSON.stringify({
        schema: statusline.PRICE_SCHEMA_VERSION,
        fetchedAt: new Date().toISOString(),
        table: {
          sonnet: { input: 999, output: 999 }, // missing fields — invalid
          haiku: { input: 1, output: 2, cacheWriteGeneric: 3, cacheRead: 4, cacheWrite5m: 5, cacheWrite1h: 6 },
        },
      }));

      // when
      const table = statusline.effectivePriceTable();

      // then — sonnet keeps the hardcoded default; haiku's valid override still applies
      assert.deepEqual(table.sonnet, statusline.PRICE_TABLE.sonnet);
      assert.deepEqual(table.haiku, { input: 1, output: 2, cacheWriteGeneric: 3, cacheRead: 4, cacheWrite5m: 5, cacheWrite1h: 6 });
    });
  });
});

test('statusline.js never calls fetch/http at render time (no network — must work fully offline)', () => {
  // given — the source of the installed statusline script
  const source = fs.readFileSync(require.resolve('../statusline.js'), 'utf8');

  // when / then — no fetch( call and no http(s) module require anywhere in the file
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/require\(['"]https?/.test(source), false);
});

test('readPluginVersion', async t => {
  await t.test('reads currentVersion from config.json', () => {
    // given — sandboxed $HOME so the module's CONFIG_PATH constant resolves inside it
    const { home, cleanup } = withTempHome();
    try {
      const statusline = loadStatusline();
      const configDir = path.join(home, '.claude', 'tokendashboard-plugin');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ currentVersion: '0.7.2' }));

      // when / then
      assert.equal(statusline.readPluginVersion(), '0.7.2');
    } finally {
      cleanup();
    }
  });

  await t.test('falls back to "unknown" when config.json is missing', () => {
    // given
    const { cleanup } = withTempHome();
    try {
      const statusline = loadStatusline();

      // when / then
      assert.equal(statusline.readPluginVersion(), 'unknown');
    } finally {
      cleanup();
    }
  });
});

test('buildStatusLine', async t => {
  await t.test('blue — empty queue, no recent error', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 1500, queue: { count: 0, oldestAgeMs: 0 }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 10,
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then
    assert.equal(
      line,
      'Claude Sonnet 5 · 1.5k token · \x1b[34m●\x1b[0m synced · context window: ▓░░░░░░░░░ 10% \n'
      + 'tokendashboard-plugin v1.2.3 · 100 ↑ / 20 ↓ · $2.50',
    );
  });

  await t.test('dimmed — fresh backlog waiting for the next flush', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 500, queue: { count: 3, oldestAgeMs: 60000 }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 65,
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then
    assert.equal(
      line,
      'Claude Sonnet 5 · 500 token · \x1b[0m●\x1b[0m 3 queued · context window: ▓▓▓▓▓▓▓░░░ \x1b[95m65%\x1b[0m \n'
      + 'tokendashboard-plugin v1.2.3 · 100 ↑ / 20 ↓ · $2.50',
    );
  });

  await t.test('red — backlog older than the staleness threshold', () => {
    // given — oldest entry is 2 days old
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

    // when
    const line = buildStatusLine({
      tokens: 500, queue: { count: 12, oldestAgeMs: twoDaysMs }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 85,
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then
    assert.equal(
      line,
      'Claude Sonnet 5 · 500 token · \x1b[31m●\x1b[0m 12 queued, 2d · context window: ▓▓▓▓▓▓▓▓▓░ \x1b[31m85% COMPACT!\x1b[0m \n'
      + 'tokendashboard-plugin v1.2.3 · 100 ↑ / 20 ↓ · $2.50',
    );
  });

  await t.test('red — recent error with a nonempty queue', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 500, queue: { count: 2, oldestAgeMs: 1000 }, recentError: true,
      modelName: 'Claude Sonnet 5', contextPct: 0,
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then
    assert.equal(
      line,
      'Claude Sonnet 5 · 500 token · \x1b[31m●\x1b[0m 2 queued, 1h · context window: ░░░░░░░░░░ 0% \n'
      + 'tokendashboard-plugin v1.2.3 · 100 ↑ / 20 ↓ · $2.50',
    );
  });

  await t.test('recent error with an empty queue does not turn the dot red (nothing pending to flush)', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 500, queue: { count: 0, oldestAgeMs: 0 }, recentError: true,
      modelName: formatModelName(undefined), contextPct: normalizeUsedPct(undefined),
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then
    assert.equal(
      line,
      'Unknown model · 500 token · \x1b[34m●\x1b[0m synced · context window: ░░░░░░░░░░ 0% \n'
      + 'tokendashboard-plugin v1.2.3 · 100 ↑ / 20 ↓ · $2.50',
    );
  });

  await t.test('pct display gets no "COMPACT!" suffix below 80%', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 0, queue: { count: 0, oldestAgeMs: 0 }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 79,
      version: '1.2.3', inputTokens: 0, outputTokens: 0, priceCents: 0,
    });

    // then — matched on the first line only; the price line always follows
    assert.match(line, /79%\x1b\[0m \n/);
  });

  await t.test('pct display gets "COMPACT!" suffix at 80%+', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 0, queue: { count: 0, oldestAgeMs: 0 }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 80,
      version: '1.2.3', inputTokens: 0, outputTokens: 0, priceCents: 0,
    });

    // then
    assert.match(line, /80% COMPACT!\x1b\[0m \n/);
  });

  await t.test('incomplete total (subagents ran) is marked as a lower bound, not a plain number', () => {
    // given / when
    const line = buildStatusLine({
      tokens: 1500, incomplete: true, queue: { count: 0, oldestAgeMs: 0 }, recentError: false,
      modelName: 'Claude Sonnet 5', contextPct: 10,
      version: '1.2.3', inputTokens: 100, outputTokens: 20, priceCents: 250,
    });

    // then — the ≥ lower-bound marker also carries onto the second line's token/price figures
    assert.equal(
      line,
      'Claude Sonnet 5 · ≥1.5k token · \x1b[34m●\x1b[0m synced · context window: ▓░░░░░░░░░ 10% \n'
      + 'tokendashboard-plugin v1.2.3 · ≥ 100 ↑ / ≥ 20 ↓ · ≥ $2.50',
    );
  });
});

test('main() reads stdin JSON and writes the status line to stdout', () => {
  // given — a sandboxed $HOME with a transcript referenced by stdin input, empty queue
  const { home, cleanup } = withTempHome();
  try {
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, assistant('id-1', { input_tokens: 100, output_tokens: 20 }));
    const input = JSON.stringify({ session_id: 's1', transcript_path: transcriptPath });

    // when
    const result = runStatuslineProcess({ home, input });

    // then — no config.json in the sandbox, so the plugin version falls back to "unknown"
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      'Unknown model · 120 token · \x1b[34m●\x1b[0m synced · context window: ░░░░░░░░░░ 0% \n'
      + 'tokendashboard-plugin vunknown · 100 ↑ / 20 ↓ · $0.00',
    );
  } finally {
    cleanup();
  }
});

test('main() reads model and context_window fields from stdin', () => {
  // given — stdin includes model display_name (with context suffix) and context_window usage
  const { home, cleanup } = withTempHome();
  try {
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, assistant('id-1', {}));
    const input = JSON.stringify({
      session_id: 's1',
      transcript_path: transcriptPath,
      model: { display_name: 'Claude Sonnet 5 (1M context)' },
      context_window: { used_percentage: 65 },
    });

    // when
    const result = runStatuslineProcess({ home, input });

    // then
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      'Claude Sonnet 5 · 0 token · \x1b[34m●\x1b[0m synced · context window: ▓▓▓▓▓▓▓░░░ \x1b[95m65%\x1b[0m \n'
      + 'tokendashboard-plugin vunknown · 0 ↑ / 0 ↓ · $0.00',
    );
  } finally {
    cleanup();
  }
});
