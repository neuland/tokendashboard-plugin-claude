'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, inSandboxAsync, pluginDir, errorLogPath, pricesPath, loadLocalStorage } = require('./helpers.js');

const sampleEntry = (overrides = {}) => ({
  entry_id: 'e1',
  session_id: 's1',
  timestamp: '2026-09-11T10:00:00.000Z',
  model: 'claude-opus-4-8',
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    ephemeral_5m_input_tokens: 2,
    ephemeral_1h_input_tokens: 1,
  },
  price_cents: 5.5,
  ...overrides,
});

test('openLocalStorageDb creates local.sqlite with the usage_entries schema', () => {
  inSandbox((hook, home) => {
    const localStorage = loadLocalStorage();
    // given — no local.sqlite yet

    // when
    const db = localStorage.openLocalStorageDb();
    try {
      // then
      assert.equal(localStorage.LOCAL_STORAGE_DB_PATH, path.join(pluginDir(home), 'local.sqlite'));
      assert.ok(fs.existsSync(localStorage.LOCAL_STORAGE_DB_PATH));
      const columns = db.prepare('PRAGMA table_info(usage_entries)').all().map(c => c.name);
      assert.deepEqual(columns.sort(), [
        'branch', 'cache_read_tokens', 'cache_write_tokens', 'entry_id',
        'ephemeral_1h_tokens', 'ephemeral_5m_tokens', 'git_project', 'input_tokens',
        'model', 'output_tokens', 'price_cents', 'project', 'session_id', 'timestamp', 'type',
      ].sort());
    } finally {
      db.close();
    }
  });
});

test('openLocalStorageDb is idempotent — reopening an existing DB does not error or reset it', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given — a DB already created and seeded
    const db1 = localStorage.openLocalStorageDb();
    db1.exec("INSERT INTO usage_entries (entry_id, session_id, timestamp, model) VALUES ('e1', 's1', 't1', 'm1')");
    db1.close();

    // when
    const db2 = localStorage.openLocalStorageDb();
    try {
      // then
      const rows = db2.prepare('SELECT * FROM usage_entries').all();
      assert.equal(rows.length, 1);
    } finally {
      db2.close();
    }
  });
});

test('writeLocalStorage inserts a row with the full token breakdown and optional fields', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given — cache_creation_input_tokens (4) > ephemeral 5m+1h breakdown (2+1=3),
    // so cache_write_tokens stores only the remainder (1), not the raw 4
    const entry = sampleEntry({ project: 'proj', branch: 'main' });

    // when
    localStorage.writeLocalStorage(entry);

    // then
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').get('e1');
      assert.equal(row.session_id, 's1');
      assert.equal(row.timestamp, '2026-09-11T10:00:00.000Z');
      assert.equal(row.model, 'claude-opus-4-8');
      assert.equal(row.input_tokens, 10);
      assert.equal(row.output_tokens, 20);
      assert.equal(row.cache_read_tokens, 3);
      assert.equal(row.cache_write_tokens, 1);
      assert.equal(row.ephemeral_5m_tokens, 2);
      assert.equal(row.ephemeral_1h_tokens, 1);
      assert.equal(row.price_cents, 5.5);
      assert.equal(row.project, 'proj');
      assert.equal(row.branch, 'main');
    } finally {
      db.close();
    }
  });
});

test('writeLocalStorage stores cache_write_tokens as the remainder above the ephemeral breakdown', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given/when/then — remainder above the 5m+1h breakdown (10 - 6 - 3 = 1)
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'remainder',
      usage: { cache_creation_input_tokens: 10, ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 3 },
    }));

    // given/when/then — breakdown covers (or exceeds) cache_creation_input_tokens entirely: clamp to 0, never negative
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'exact',
      usage: { cache_creation_input_tokens: 9, ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 3 },
    }));
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'exceeds',
      usage: { cache_creation_input_tokens: 5, ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 3 },
    }));

    // given/when/then — no ephemeral breakdown at all: cache_write_tokens falls back to the raw total
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'no-breakdown',
      usage: { cache_creation_input_tokens: 4 },
    }));

    const db = localStorage.openLocalStorageDb();
    try {
      assert.equal(db.prepare('SELECT cache_write_tokens FROM usage_entries WHERE entry_id = ?').get('remainder').cache_write_tokens, 1);
      assert.equal(db.prepare('SELECT cache_write_tokens FROM usage_entries WHERE entry_id = ?').get('exact').cache_write_tokens, 0);
      assert.equal(db.prepare('SELECT cache_write_tokens FROM usage_entries WHERE entry_id = ?').get('exceeds').cache_write_tokens, 0);
      assert.equal(db.prepare('SELECT cache_write_tokens FROM usage_entries WHERE entry_id = ?').get('no-breakdown').cache_write_tokens, 4);
    } finally {
      db.close();
    }
  });
});

test('writeLocalStorage defaults missing usage/price/project/branch to 0/null', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given — minimal entry, no usage breakdown and no project/branch/price
    const entry = { entry_id: 'e2', session_id: 's1', timestamp: 't', model: 'm' };

    // when
    localStorage.writeLocalStorage(entry);

    // then
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').get('e2');
      assert.equal(row.input_tokens, 0);
      assert.equal(row.output_tokens, 0);
      assert.equal(row.cache_read_tokens, 0);
      assert.equal(row.cache_write_tokens, 0);
      assert.equal(row.ephemeral_5m_tokens, 0);
      assert.equal(row.ephemeral_1h_tokens, 0);
      assert.equal(row.price_cents, 0);
      assert.equal(row.project, null);
      assert.equal(row.branch, null);
    } finally {
      db.close();
    }
  });
});

test('writeLocalStorage upserts by entry_id — a later write overwrites, never duplicates', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given — a stale (non-finalized) capture already written
    localStorage.writeLocalStorage(sampleEntry({ usage: { input_tokens: 1, output_tokens: 1 } }));

    // when — a later, finalized capture for the same entry_id
    localStorage.writeLocalStorage(sampleEntry({ usage: { input_tokens: 10, output_tokens: 20 } }));

    // then — one row, holding the later values
    const db = localStorage.openLocalStorageDb();
    try {
      const rows = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').all('e1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].input_tokens, 10);
      assert.equal(rows[0].output_tokens, 20);
    } finally {
      db.close();
    }
  });
});

test('writeLocalStorage never throws and logs to error.log when the DB file is unusable', () => {
  inSandbox((hook, home) => {
    const localStorage = loadLocalStorage();
    // given — local.sqlite path occupied by a directory, so opening it as a DB fails
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.mkdirSync(localStorage.LOCAL_STORAGE_DB_PATH);

    // when / then — does not throw
    assert.doesNotThrow(() => localStorage.writeLocalStorage(sampleEntry()));

    const log = fs.readFileSync(errorLogPath(home), 'utf8');
    assert.match(log, /writeLocalStorage/);
  });
});

test('isMissingSqliteModule identifies a missing node:sqlite failure, not other errors', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given / when / then — the exact failure Node <22.13 throws for require('node:sqlite')
    const sqliteErr = Object.assign(new Error('No such built-in module: node:sqlite'), {
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
    assert.equal(localStorage.isMissingSqliteModule(sqliteErr), true);

    // given / when / then — an unrelated error, or the same code for an unrelated module
    assert.equal(localStorage.isMissingSqliteModule(new Error('disk full')), false);
    assert.equal(
      localStorage.isMissingSqliteModule(Object.assign(new Error('No such built-in module: node:test'), {
        code: 'ERR_UNKNOWN_BUILTIN_MODULE',
      })),
      false,
    );
  });
});

const oneTurnTranscript = () => `${JSON.stringify({
  type: 'user',
  message: { content: 'hi' },
})}\n${JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-11T10:00:00.000Z',
  message: {
    id: 'msg_1',
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})}\n`;

test('capture() (Stop) writes the same entry to local.sqlite as to the queue (step 2)', async () => {
  await inSandboxAsync(async (hook, home) => {
    const localStorage = loadLocalStorage();
    // given
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, oneTurnTranscript());

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 's1' });

    // then — queue and local.sqlite hold the matching row
    const [queued] = hook.getQueueFiles().map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    assert.ok(queued);
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').get(queued.entry_id);
      assert.ok(row, 'expected a local.sqlite row for the captured entry_id');
      assert.equal(row.session_id, 's1');
      assert.equal(row.model, 'claude-opus-4-8');
      assert.equal(row.input_tokens, 1);
      assert.equal(row.output_tokens, 1);
      // 'opus' key: 1 * 500 (input) + 1 * 2500 (output) = 3000 micro-cents = 0.003 cents
      assert.equal(row.price_cents, 0.003);
    } finally {
      db.close();
    }
  });
});

test('captureSubagent writes to local.sqlite (step 3)', async () => {
  await inSandboxAsync(async (hook, home) => {
    const localStorage = loadLocalStorage();
    // given
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, oneTurnTranscript());

    // when
    await hook.captureSubagent({ agent_transcript_path: transcriptPath, session_id: 's1' });

    // then
    const [queued] = hook.getQueueFiles().map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').get(queued.entry_id);
      assert.ok(row, 'expected a local.sqlite row for the subagent capture');
    } finally {
      db.close();
    }
  });
});

test('catchUpCapture writes to local.sqlite (step 3)', async () => {
  await inSandboxAsync(async (hook, home) => {
    const localStorage = loadLocalStorage();
    // given — a turn Stop never fired for (e.g. user interrupt)
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, oneTurnTranscript());

    // when
    await hook.catchUpCapture({ transcript_path: transcriptPath, session_id: 's1' });

    // then
    const [queued] = hook.getQueueFiles().map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries WHERE entry_id = ?').get(queued.entry_id);
      assert.ok(row, 'expected a local.sqlite row for the catch-up capture');
    } finally {
      db.close();
    }
  });
});

test('catchUpCapture re-aggregating a turn Stop already captured upserts — one row, not a duplicate', async () => {
  await inSandboxAsync(async (hook, home) => {
    const localStorage = loadLocalStorage();
    // given — Stop already captured this exact turn
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, oneTurnTranscript());
    await hook.capture({ transcript_path: transcriptPath, session_id: 's1' });

    // when — SessionEnd re-aggregates the same trailing turn (ADR-015)
    await hook.catchUpCapture({ transcript_path: transcriptPath, session_id: 's1' });

    // then — same deterministic entry_id both times, still exactly one row
    const db = localStorage.openLocalStorageDb();
    try {
      const rows = db.prepare('SELECT * FROM usage_entries').all();
      assert.equal(rows.length, 1);
    } finally {
      db.close();
    }
  });
});

// --- Price computation for local storage ---

const sampleUsage = () => ({
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
});

test('priceCentsForModel uses the hardcoded PRICE_TABLE when no cache is present', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given — 'opus' key: 500 (input) + 2500 (output) cents per million tokens
    const usage = sampleUsage();

    // when
    const cents = localStorage.priceCentsForModel('claude-opus-4-8', usage);

    // then
    assert.equal(cents, 3000);
  });
});

test('priceCentsForModel returns null for a model matching no price key', () => {
  inSandbox(() => {
    const localStorage = loadLocalStorage();
    // given
    const usage = sampleUsage();

    // when
    const cents = localStorage.priceCentsForModel('some-unknown-model', usage);

    // then
    assert.equal(cents, null);
  });
});

test('effectivePriceTable merges a cached prices.json entry over the hardcoded default, per model', () => {
  inSandbox((hook, home) => {
    const localStorage = loadLocalStorage();
    // given — cache overrides only 'opus', 'sonnet' stays hardcoded
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(pricesPath(home), JSON.stringify({
      schema: localStorage.PRICE_SCHEMA_VERSION,
      fetchedAt: new Date().toISOString(),
      table: {
        opus: { input: 999, output: 999, cacheWriteGeneric: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
      },
    }));

    // when
    const table = localStorage.effectivePriceTable();

    // then
    assert.equal(table.opus.input, 999);
    assert.equal(table.sonnet.input, localStorage.PRICE_TABLE.sonnet.input);
  });
});

test('capture() (Stop) records price_cents 0 (not a crash) for a model matching no price key', async () => {
  await inSandboxAsync(async (hook, home) => {
    const localStorage = loadLocalStorage();
    // given — a model no price key matches
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: 'user',
      message: { content: 'hi' },
    })}\n${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-11T10:00:00.000Z',
      message: {
        id: 'msg_1',
        model: 'totally-unknown-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n`);

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 's1' });

    // then
    const db = localStorage.openLocalStorageDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries').get();
      assert.equal(row.price_cents, 0);
    } finally {
      db.close();
    }
  });
});
