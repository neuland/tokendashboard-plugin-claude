'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, loadUpdater, pluginDir } = require('./helpers.js');

test('loadConfig returns {} when no config file exists', () => {
  inSandbox(hook => {
    // given — a fresh sandbox with no config file

    // when
    const config = hook.loadConfig();

    // then
    assert.deepEqual(config, {});
  });
});

test('loadConfig returns {} on malformed JSON', () => {
  inSandbox((hook, home) => {
    // given — a config file containing invalid JSON
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(home), 'config.json'), '{ not valid');

    // when
    const config = hook.loadConfig();

    // then
    assert.deepEqual(config, {});
  });
});

test('saveConfig then loadConfig round-trips and creates the plugin dir', () => {
  inSandbox((hook, home) => {
    // given — the plugin dir does not exist yet; saveConfig now lives in updater.js, but
    // both modules read the same config.json, so a save there is visible to hook.loadConfig
    const updater = loadUpdater();
    assert.equal(fs.existsSync(pluginDir(home)), false);

    // when
    updater.saveConfig({ currentVersion: '0.2.0', lastUpdateCheck: '2026-06-22T00:00:00.000Z' });

    // then
    assert.deepEqual(hook.loadConfig(), {
      currentVersion: '0.2.0',
      lastUpdateCheck: '2026-06-22T00:00:00.000Z',
    });
  });
});

test('getUserId creates a stable UUID file', () => {
  inSandbox((hook, home) => {
    // given — a fresh sandbox with no user-id file

    // when
    const id1 = hook.getUserId();

    // then — a UUID is generated, persisted, and stable across calls
    assert.match(id1, /^[0-9a-f-]{36}$/);
    assert.equal(fs.existsSync(path.join(pluginDir(home), 'user-id')), true);
    assert.equal(hook.getUserId(), id1);
  });
});

test('getUserId trims surrounding whitespace from an existing id file', () => {
  inSandbox((hook, home) => {
    // given — an existing id file with surrounding whitespace
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(home), 'user-id'), '  abc-123\n');

    // when
    const id = hook.getUserId();

    // then
    assert.equal(id, 'abc-123');
  });
});

test('atomicWriteSync leaves no .tmp file behind', () => {
  inSandbox((hook, home) => {
    // given
    fs.mkdirSync(home, { recursive: true });
    const target = path.join(home, 'out.txt');

    // when
    hook.atomicWriteSync(target, 'hello');

    // then
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(home).filter(f => f.includes('.tmp')), []);
  });
});
