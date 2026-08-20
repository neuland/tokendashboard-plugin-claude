'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, inFlushSandbox, stubFetch, queueDir, configPath, TEST_API_BASE_URL } = require('./helpers.js');

const ok = { ok: true, status: 200 };

test('flush does nothing and makes no request on an empty queue', async () => {
  await inFlushSandbox(async hook => {
    // given — an empty queue
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
  });
});

test('flush posts all entries and clears the queue on HTTP 200', async () => {
  await inFlushSandbox(async hook => {
    // given — two queued entries
    hook.writeEntry({ session_id: 's1', model: 'claude-opus-4-8', usage: { input_tokens: 1 } });
    hook.writeEntry({ session_id: 's1', model: 'claude-haiku-4-5', usage: { input_tokens: 2 } });
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — one POST carrying user_id + both entries, queue emptied afterwards
    assert.equal(fetch.calls.length, 1);
    const body = JSON.parse(fetch.calls[0].options.body);
    assert.match(body.user_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.prompts.length, 2);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush posts to the API base URL joined with the fixed ingest route', async () => {
  await inFlushSandbox(async hook => {
    // given — a queued entry
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls[0].url, `${TEST_API_BASE_URL}/api/usage/ingest/claude`);
  });
});

test('flush payload carries the current plugin version from config.json', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — a queued entry and a config.json recording the installed version
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    fs.writeFileSync(configPath(home), JSON.stringify({ currentVersion: '0.4.0', apiBaseUrl: TEST_API_BASE_URL }));
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — the POST body reports plugin_version alongside user_id and prompts
    const body = JSON.parse(fetch.calls[0].options.body);
    assert.equal(body.plugin_version, '0.4.0');
  });
});

test('flush keeps entries queued on a network error', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — a queued entry and a failing network
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — entry remains and the lock was released
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(path.join(queueDir(home), '.lock')), false);
  });
});

test('flush keeps entries queued on a non-2xx response', async () => {
  await inFlushSandbox(async hook => {
    // given — a queued entry and a server error
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ({ ok: false, status: 500 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('flush skips an unparseable queue file but still posts the valid ones', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — one good entry plus a corrupt queue file
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    fs.writeFileSync(path.join(queueDir(home), '999-1-0.json'), 'not json {');
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — only the valid entry is sent; the whole snapshot (incl. the bad file) is cleared
    assert.equal(fetch.calls.length, 1);
    assert.equal(JSON.parse(fetch.calls[0].options.body).prompts.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush makes no request when every queued file is unparseable', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — a queue containing only corrupt files
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(path.join(queueDir(home), '999-1-0.json'), 'garbage');
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — nothing parseable to send, so no request; the lock is released
    assert.equal(fetch.calls.length, 0);
    assert.equal(fs.existsSync(path.join(queueDir(home), '.lock')), false);
  });
});

test('flush sends entries in bounded batches and clears the queue', async () => {
  await inFlushSandbox(async hook => {
    // given — one more entry than fits in a single batch
    const count = hook.FLUSH_BATCH_SIZE + 1;
    for (let i = 0; i < count; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i } });
    }
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — two POSTs (FLUSH_BATCH_SIZE + 1), no batch larger than FLUSH_BATCH_SIZE, queue emptied
    assert.equal(fetch.calls.length, 2);
    assert.equal(JSON.parse(fetch.calls[0].options.body).prompts.length, hook.FLUSH_BATCH_SIZE);
    assert.equal(JSON.parse(fetch.calls[1].options.body).prompts.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush drops a batch the server permanently rejects (HTTP 400)', async () => {
  await inFlushSandbox(async hook => {
    // given — a queued entry the endpoint rejects with a 4xx (poison pill)
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ({ ok: false, status: 400 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — the rejected entry is discarded so it can't block the queue forever
    assert.equal(fetch.calls.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush keeps a batch on a retryable 4xx (HTTP 429)', async () => {
  await inFlushSandbox(async hook => {
    // given — a queued entry and a rate-limited endpoint
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ({ ok: false, status: 429 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — 429 is transient, so the entry is retained for the next session
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('flush keeps a batch on a reachability 4xx (HTTP 401/403)', async () => {
  // 403 is what the public nginx returns off-VPN; the backend never saw the payload,
  // so the queue must survive rather than be dropped as a poison pill (see ADR-005).
  for (const status of [401, 403]) {
    await inFlushSandbox(async hook => {
      // given — a queued entry and an endpoint reachable only via VPN
      hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
      const fetch = stubFetch(() => ({ ok: false, status }));

      // when
      try {
        await hook.flush();
      } finally {
        fetch.restore();
      }

      // then — the entry is retained for the next (on-VPN) session
      assert.equal(hook.getQueueFiles().length, 1, `HTTP ${status} should retain the queue`);
    });
  }
});

test('flush stops after a transient failure and retains later batches', async () => {
  await inFlushSandbox(async hook => {
    // given — two batches' worth of entries; the first POST fails transiently
    const count = hook.FLUSH_BATCH_SIZE + 1;
    for (let i = 0; i < count; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i } });
    }
    const fetch = stubFetch(() => ({ ok: false, status: 500 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — it gives up after the first failed batch; nothing is lost
    assert.equal(fetch.calls.length, 1);
    assert.equal(hook.getQueueFiles().length, count);
  });
});

test('flush drops entries older than the age cap before sending', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — one fresh entry plus a file whose enqueue-time prefix is ancient
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    fs.writeFileSync(
      path.join(queueDir(home), '1000-1-0.json'),
      JSON.stringify({ session_id: 'old', model: 'm', usage: {} }),
    );
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — the stale entry is pruned (not sent); only the fresh one is posted
    assert.equal(fetch.calls.length, 1);
    assert.equal(JSON.parse(fetch.calls[0].options.body).prompts.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush makes no request and keeps the queue when no API base URL is configured', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry but config.json carries no apiBaseUrl (e.g. a pre-migration install)
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    fs.writeFileSync(configPath(home), JSON.stringify({ currentVersion: '0.4.0' }));
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — nothing sent, entry stays queued for a future, reconfigured session
    assert.equal(fetch.calls.length, 0);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('flush makes no request when the lock is held by a live process', async () => {
  await inFlushSandbox(async (hook, home) => {
    // given — a queued entry and a lock held by a live process (the test runner)
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    fs.writeFileSync(path.join(queueDir(home), '.lock'), String(process.pid));
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — no request, entry stays queued, foreign lock untouched
    assert.equal(fetch.calls.length, 0);
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.readFileSync(path.join(queueDir(home), '.lock'), 'utf8'), String(process.pid));
  });
});
