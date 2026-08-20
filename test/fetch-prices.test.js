'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { inSandboxAsync, configPath, pricesPath, TEST_API_BASE_URL } = require('./helpers.js');
const hook = require('../hook.js');

// Mirrors .claude/example-price-api.json's shape (flat, model-keyed, verbose field names,
// no wrapper — see ADR-017).
const VALID_RESPONSE = {
  sonnet: {
    inputCentPerMillion: 300, outputCentPerMillion: 1500, cacheWrite5mCentPerMillion: 375,
    cacheWrite1hCentPerMillion: 600, cacheWriteCentPerMillion: 375, cacheReadCentPerMillion: 30,
  },
  haiku: {
    inputCentPerMillion: 100, outputCentPerMillion: 500, cacheWrite5mCentPerMillion: 125,
    cacheWrite1hCentPerMillion: 200, cacheWriteCentPerMillion: 125, cacheReadCentPerMillion: 10,
  },
};

const seedInstalled = home => fs.writeFileSync(
  configPath(home),
  JSON.stringify({ currentVersion: '0.6.0', apiBaseUrl: TEST_API_BASE_URL }),
);

const fakeFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, json: async () => body,
});

test('fetchPrices writes prices.json on a valid response, mapping response field names to internal ones', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed, valid response for two models
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    seedInstalled(home);

    // when
    await hook.fetchPrices(fakeFetch(VALID_RESPONSE));

    // then
    const cache = JSON.parse(fs.readFileSync(pricesPath(home), 'utf8'));
    assert.equal(cache.schema, hook.PRICE_SCHEMA_VERSION);
    assert.ok(cache.fetchedAt);
    assert.deepEqual(cache.table.sonnet, {
      input: 300, output: 1500, cacheWriteGeneric: 375, cacheRead: 30, cacheWrite5m: 375, cacheWrite1h: 600,
    });
    assert.deepEqual(cache.table.haiku, {
      input: 100, output: 500, cacheWriteGeneric: 125, cacheRead: 10, cacheWrite5m: 125, cacheWrite1h: 200,
    });
  });
});

test('fetchPrices leaves prices.json untouched on a non-ok response', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed, but the request fails
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    seedInstalled(home);

    // when
    await hook.fetchPrices(fakeFetch(VALID_RESPONSE, { ok: false, status: 503 }));

    // then — no cache file written at all (never reached, not just "unchanged")
    assert.equal(fs.existsSync(pricesPath(home)), false);
  });
});

test('fetchPrices leaves prices.json untouched on unparseable JSON', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    seedInstalled(home);
    const throwingFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });

    // when
    await hook.fetchPrices(throwingFetch);

    // then
    assert.equal(fs.existsSync(pricesPath(home)), false);
  });
});

test('fetchPrices drops individually-invalid model entries but keeps the valid ones', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — haiku is missing a required field; sonnet is valid
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    seedInstalled(home);
    const response = {
      sonnet: VALID_RESPONSE.sonnet,
      haiku: { inputCentPerMillion: 100 }, // missing the rest — invalid
    };

    // when
    await hook.fetchPrices(fakeFetch(response));

    // then — sonnet cached, haiku dropped
    const cache = JSON.parse(fs.readFileSync(pricesPath(home), 'utf8'));
    assert.ok(cache.table.sonnet);
    assert.equal(cache.table.haiku, undefined);
  });
});

test('fetchPrices writes nothing when every entry is invalid — never clobbers a good cache with an empty one', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a previously-good cache from an earlier successful fetch
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    seedInstalled(home);
    const goodCache = { schema: hook.PRICE_SCHEMA_VERSION, fetchedAt: '2026-01-01T00:00:00.000Z', table: { sonnet: { input: 1, output: 1, cacheWriteGeneric: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 } } };
    fs.writeFileSync(pricesPath(home), JSON.stringify(goodCache));

    // when — this round's response is entirely invalid
    await hook.fetchPrices(fakeFetch({ sonnet: { inputCentPerMillion: 'not a number' } }));

    // then — the previously-good cache survives untouched
    assert.deepEqual(JSON.parse(fs.readFileSync(pricesPath(home), 'utf8')), goodCache);
  });
});

test('fetchPrices no-ops when not installed', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — no config.json at all
    let called = false;

    // when
    await hook.fetchPrices(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => VALID_RESPONSE };
    });

    // then — never even attempted the request
    assert.equal(called, false);
    assert.equal(fs.existsSync(pricesPath(home)), false);
  });
});

test('fetchPrices no-ops when installed but apiBaseUrl is absent (raced with uninstall, or predates the requirement)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    fs.mkdirSync(require('path').dirname(configPath(home)), { recursive: true });
    fs.writeFileSync(configPath(home), JSON.stringify({ currentVersion: '0.6.0' }));
    let called = false;

    // when
    await hook.fetchPrices(async () => {
      called = true;
      return { ok: true, status: 200, json: async () => VALID_RESPONSE };
    });

    // then
    assert.equal(called, false);
    assert.equal(fs.existsSync(pricesPath(home)), false);
  });
});

test('sanitizePriceEntry validates all six fields and rejects negative/non-finite/missing values', () => {
  // given / when / then
  assert.deepEqual(hook.sanitizePriceEntry({
    inputCentPerMillion: 300, outputCentPerMillion: 1500, cacheWrite5mCentPerMillion: 375,
    cacheWrite1hCentPerMillion: 600, cacheWriteCentPerMillion: 375, cacheReadCentPerMillion: 30,
  }), { input: 300, output: 1500, cacheWriteGeneric: 375, cacheRead: 30, cacheWrite5m: 375, cacheWrite1h: 600 });
  assert.equal(hook.sanitizePriceEntry({ inputCentPerMillion: -1, outputCentPerMillion: 1, cacheWrite5mCentPerMillion: 1, cacheWrite1hCentPerMillion: 1, cacheWriteCentPerMillion: 1, cacheReadCentPerMillion: 1 }), null);
  assert.equal(hook.sanitizePriceEntry({ inputCentPerMillion: Infinity, outputCentPerMillion: 1, cacheWrite5mCentPerMillion: 1, cacheWrite1hCentPerMillion: 1, cacheWriteCentPerMillion: 1, cacheReadCentPerMillion: 1 }), null);
  assert.equal(hook.sanitizePriceEntry({ outputCentPerMillion: 1 }), null);
  assert.equal(hook.sanitizePriceEntry(null), null);
  assert.equal(hook.sanitizePriceEntry('not an object'), null);
});

test('sanitizePriceTable returns null when nothing validates, and drops bad entries individually otherwise', () => {
  // given / when / then
  assert.equal(hook.sanitizePriceTable({}), null);
  assert.equal(hook.sanitizePriceTable(null), null);
  assert.equal(hook.sanitizePriceTable({ sonnet: { inputCentPerMillion: 'nope' } }), null);
  const mixed = hook.sanitizePriceTable({
    sonnet: VALID_RESPONSE.sonnet,
    broken: { inputCentPerMillion: 'nope' },
  });
  assert.ok(mixed.sonnet);
  assert.equal(mixed.broken, undefined);
});
