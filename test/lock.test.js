'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, queueDir } = require('./helpers.js');

const DEAD_PID = 2147483647; // out of range — guaranteed no such process
const lockPath = home => path.join(queueDir(home), '.lock');

test('isProcessAlive: true for self, false for a non-existent pid', () => {
  inSandbox(hook => {
    // given / when / then
    assert.equal(hook.isProcessAlive(process.pid), true);
    assert.equal(hook.isProcessAlive(DEAD_PID), false);
  });
});

test('acquireLock succeeds on a free queue and writes our pid', () => {
  inSandbox((hook, home) => {
    // given — an existing queue dir with no lock
    fs.mkdirSync(queueDir(home), { recursive: true });

    // when
    const acquired = hook.acquireLock();

    // then
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('releaseLock removes the lock file', () => {
  inSandbox((hook, home) => {
    // given — a held lock
    fs.mkdirSync(queueDir(home), { recursive: true });
    hook.acquireLock();

    // when
    hook.releaseLock();

    // then
    assert.equal(fs.existsSync(lockPath(home)), false);
  });
});

test('acquireLock fails when the lock is held by a live process', () => {
  inSandbox((hook, home) => {
    // given — a lock owned by a live process (the test runner itself)
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), String(process.pid));

    // when
    const acquired = hook.acquireLock();

    // then — acquisition fails and the live lock is left intact
    assert.equal(acquired, false);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('acquireLock steals a stale lock owned by a dead process', () => {
  inSandbox((hook, home) => {
    // given — a lock owned by a dead process
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), String(DEAD_PID));

    // when
    const acquired = hook.acquireLock();

    // then — the stale lock is stolen and now holds our pid
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});
