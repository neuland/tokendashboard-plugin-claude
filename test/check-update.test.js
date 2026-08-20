'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, inSandboxAsync, loadUpdater, hookDest, legacyHookDest } = require('./helpers.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// Capture the modes checkUpdate would spawn, without launching real processes.
const recordSpawns = () => {
  const modes = [];
  return { modes, spawnFn: mode => modes.push(mode) };
};

// Seed config.json (saveConfig lives in updater.js now; both modules share the file).
const seedConfig = config => loadUpdater().saveConfig(config);

test('checkUpdate always spawns a flush', () => {
  inSandbox((hook, home) => {
    // given — no config at all
    const { modes, spawnFn } = recordSpawns();

    // when — running from the canonical path so migration is not forced
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — flush runs even though there is nothing to update
    assert.deepEqual(modes, ['--flush']);
  });
});

test('checkUpdate does not check for updates without a currentVersion', () => {
  inSandbox((hook, home) => {
    // given — config exists but carries no version
    seedConfig({ lastUpdateCheck: null });
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — flush only, no --update
    assert.deepEqual(modes, ['--flush']);
  });
});

test('checkUpdate spawns an update when no check has run yet', () => {
  inSandbox((hook, home) => {
    // given — a known version, price and update never checked
    seedConfig({ currentVersion: '0.4.0' });
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — flush, price fetch, and the update
    assert.deepEqual(modes, ['--flush', '--fetch-prices', '--update']);
  });
});

test('checkUpdate skips the update when the last check is younger than 24h', () => {
  inSandbox((hook, home) => {
    // given — checked one hour ago, running from the canonical path
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — update gated by the 24h interval, but the price fetch has its own (never-run) clock
    assert.deepEqual(modes, ['--flush', '--fetch-prices']);
  });
});

test('checkUpdate spawns an update when the last check is older than 24h', () => {
  inSandbox((hook, home) => {
    // given — checked just over a day ago
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - DAY_MS - 1000).toISOString(),
    });
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — interval elapsed, update re-probed
    assert.deepEqual(modes, ['--flush', '--fetch-prices', '--update']);
  });
});

test('checkUpdate does not force an update when the path only differs by a symlink', { skip: process.platform === 'win32' }, () => {
  inSandbox((hook, home) => {
    // given — the real hook at the canonical path, a symlink pointing at it, and a recent
    // check. Node realpath-resolves __filename, so without a realpath-aware compare a
    // symlinked config dir would look non-canonical and re-fetch every session.
    const canonical = hookDest(home);
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '// hook');
    const link = path.join(home, 'link-hook.js');
    fs.symlinkSync(canonical, link);
    seedConfig({ currentVersion: '0.4.0', lastUpdateCheck: new Date().toISOString() });
    const { modes, spawnFn } = recordSpawns();

    // when — invoked via the symlink (as a realpath'd __filename resolves to the target)
    hook.checkUpdate(spawnFn, link);

    // then — realpath makes the two equal, so migration is not forced and the update throttle
    // holds; the price fetch has its own never-run clock and still fires
    assert.deepEqual(modes, ['--flush', '--fetch-prices']);
  });
});

test('checkUpdate forces an update from a non-canonical path even within 24h', () => {
  inSandbox((hook, home) => {
    // given — a recent check that would normally throttle, but running from the legacy
    // path (frozen 0.3.5 delivered the new hook there): migration must not wait 24h.
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const { modes, spawnFn } = recordSpawns();

    // when — selfPath is the legacy location, not hookDest
    hook.checkUpdate(spawnFn, legacyHookDest(home));

    // then — the throttle is overridden, the migration update is spawned immediately
    assert.deepEqual(modes, ['--flush', '--fetch-prices', '--update']);
  });
});

test('checkUpdate respects the throttle for a migration blocked by an older remote', () => {
  inSandbox((hook, home) => {
    // given — mid-migration from a non-canonical path, but converge has flagged the migration as
    // blocked by a rolled-back (older) remote, with a recent check. Without the flag gate this
    // would force an --update every session (a per-session fetch storm — see ADR-012).
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      migrationBlocked: true,
    });
    const { modes, spawnFn } = recordSpawns();

    // when — running from the legacy path (migration still pending)
    hook.checkUpdate(spawnFn, legacyHookDest(home));

    // then — the bypass is withheld, so the 24h throttle holds and no --update storm occurs;
    // the price fetch is unaffected by the code-update throttle/migration state
    assert.deepEqual(modes, ['--flush', '--fetch-prices']);
  });
});

test('checkUpdate still spawns a blocked migration once the throttle expires', () => {
  inSandbox((hook, home) => {
    // given — migration blocked by an older remote, but the last check is now stale (>24h). We
    // still want ONE background --update so the install recovers the moment the remote rolls
    // forward again — just not one per session.
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - DAY_MS - 1000).toISOString(),
      migrationBlocked: true,
    });
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, legacyHookDest(home));

    // then — the elapsed interval re-probes exactly once (self-healing, not a storm)
    assert.deepEqual(modes, ['--flush', '--fetch-prices', '--update']);
  });
});

test('checkUpdate skips the price fetch when its own cache is younger than 7 days, independent of the code-update throttle', () => {
  inSandbox((hook, home) => {
    // given — a fresh price cache, but a code-update check stale enough to be due — proves the
    // two throttles don't share state in either direction
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - DAY_MS - 1000).toISOString(),
    });
    fs.mkdirSync(path.dirname(hook.PRICES_CACHE_PATH), { recursive: true });
    fs.writeFileSync(hook.PRICES_CACHE_PATH, JSON.stringify({
      schema: hook.PRICE_SCHEMA_VERSION,
      fetchedAt: new Date().toISOString(),
      table: {},
    }));
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — code update is due and spawned, but the recently-fetched price cache is not
    assert.deepEqual(modes, ['--flush', '--update']);
  });
});

test('checkUpdate spawns the price fetch when its cache is stale, even while the code-update throttle holds', () => {
  inSandbox((hook, home) => {
    // given — code-update checked recently (throttled), but the price cache is a week+ stale
    seedConfig({
      currentVersion: '0.4.0',
      lastUpdateCheck: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    fs.mkdirSync(path.dirname(hook.PRICES_CACHE_PATH), { recursive: true });
    fs.writeFileSync(hook.PRICES_CACHE_PATH, JSON.stringify({
      schema: hook.PRICE_SCHEMA_VERSION,
      fetchedAt: new Date(Date.now() - 7 * DAY_MS - 1000).toISOString(),
      table: {},
    }));
    const { modes, spawnFn } = recordSpawns();

    // when
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — price fetch spawned despite the code-update throttle holding
    assert.deepEqual(modes, ['--flush', '--fetch-prices']);
  });
});

test('a failed --fetch-prices run (e.g. VPN off) is retried the very next session, not throttled a full week', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed, price fetch never stamped a fetchedAt yet, and this session's
    // fetch attempt fails (unreachable) — fetchPrices() must leave prices.json untouched
    seedConfig({
      currentVersion: '0.4.0',
      apiBaseUrl: 'https://example.test',
      lastUpdateCheck: new Date().toISOString(), // code-update throttled — isolate the price-fetch behavior under test
    });
    await hook.fetchPrices(async () => null); // fetchWithTimeout-style failure: no response
    assert.equal(fs.existsSync(hook.PRICES_CACHE_PATH), false, 'no cache written on failure');

    // when — a later session (same day) checks again
    const { modes, spawnFn } = recordSpawns();
    hook.checkUpdate(spawnFn, hookDest(home));

    // then — no stamped fetchedAt means the throttle never engaged; retried immediately
    assert.deepEqual(modes, ['--flush', '--fetch-prices']);
  });
});
