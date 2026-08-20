'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, queueDir } = require('./helpers.js');

test('getQueueFiles returns [] when the queue dir does not exist', () => {
  inSandbox(hook => {
    // given — a fresh sandbox with no queue dir

    // when
    const files = hook.getQueueFiles();

    // then
    assert.deepEqual(files, []);
  });
});

test('writeEntry creates the queue dir and a parseable entry file', () => {
  inSandbox((hook, home) => {
    // given
    const entry = { session_id: 's1', model: 'claude-opus-4-8', usage: { input_tokens: 5 } };

    // when
    hook.writeEntry(entry);

    // then
    const files = hook.getQueueFiles();
    assert.equal(files.length, 1);
    assert.equal(path.dirname(files[0]), queueDir(home));
    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), entry);
  });
});

test('multiple writeEntry calls in one process produce unique files', () => {
  inSandbox(hook => {
    // given — three writes that may land in the same millisecond

    // when
    hook.writeEntry({ n: 1 });
    hook.writeEntry({ n: 2 });
    hook.writeEntry({ n: 3 });

    // then — writeCounter guarantees unique filenames
    const files = hook.getQueueFiles();
    assert.equal(files.length, 3);
    assert.equal(new Set(files).size, 3);
  });
});

test('getQueueFiles excludes the .lock dotfile and non-json files', () => {
  inSandbox((hook, home) => {
    // given — a queue dir with one entry plus noise files
    const dir = queueDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-1-0.json'), '{}');
    fs.writeFileSync(path.join(dir, '.lock'), '999');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');

    // when
    const files = hook.getQueueFiles();

    // then
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('123-1-0.json'));
  });
});

test('writeEntry leaves no .tmp file behind (atomic publish via rename)', () => {
  inSandbox((hook, home) => {
    // given
    const dir = queueDir(home);

    // when
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });

    // then — only the final .json is present; the intermediate .tmp was renamed away,
    // so a concurrent flush can never read a half-written entry under its final name
    const all = fs.readdirSync(dir);
    assert.equal(all.filter(f => f.endsWith('.tmp')).length, 0);
    assert.equal(all.filter(f => f.endsWith('.json')).length, 1);
  });
});

test('getQueueFiles ignores a .tmp write-in-progress file', () => {
  inSandbox((hook, home) => {
    // given — a partially written entry still under its tmp name, plus a finished one
    const dir = queueDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-1-0.json'), '{}');
    fs.writeFileSync(path.join(dir, `456-1-0.json.${process.pid}.tmp`), '{"hal');

    // when
    const files = hook.getQueueFiles();

    // then — the tmp file is invisible to flush, so it can't be parsed-and-deleted mid-write
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('123-1-0.json'));
  });
});
