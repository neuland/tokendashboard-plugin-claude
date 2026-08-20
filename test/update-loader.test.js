'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, stubFetch, pluginDir } = require('./helpers.js');

// hook.js's --update mode (updateFromRemote) fetches updater.js fresh from the repo and
// hands the source to a runner (which, in production, pipes it to `node -`). See ADR-012.

const seedVersion = home => {
  fs.mkdirSync(pluginDir(home), { recursive: true });
  fs.writeFileSync(path.join(pluginDir(home), 'config.json'), JSON.stringify({ currentVersion: '0.4.0' }));
};

const seedVersionWithRepoUrl = (home, repoRawBaseUrl) => {
  fs.mkdirSync(pluginDir(home), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir(home), 'config.json'),
    JSON.stringify({ currentVersion: '0.4.0', repoRawBaseUrl })
  );
};

test('updateFromRemote fetches updater.js and passes the source to the runner', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed with an update source configured, and the repo serves updater source
    seedVersionWithRepoUrl(home, 'https://raw.githubusercontent.com/foo/bar/main');
    let ran = null;
    const f = stubFetch(() => ({ ok: true, status: 200, text: async () => '// updater source' }));
    // when
    try {
      await hook.updateFromRemote(src => {
        ran = src;
      });
    } finally {
      f.restore();
    }
    // then — the fetched source is handed to the runner
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.endsWith('/updater.js'));
    assert.equal(ran, '// updater source');
  });
});

test('updateFromRemote fetches from the configured repoRawBaseUrl when present', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed with a configured override
    seedVersionWithRepoUrl(home, 'https://raw.githubusercontent.com/foo/bar/main');
    const f = stubFetch(() => ({ ok: true, status: 200, text: async () => '// updater source' }));
    // when
    try {
      await hook.updateFromRemote(() => {});
    } finally {
      f.restore();
    }
    // then — the fetched URL reflects the configured base
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://raw.githubusercontent.com/foo/bar/main/updater.js');
  });
});

test('updateFromRemote is a no-op when repoRawBaseUrl is not configured — no fallback default (ADR-016)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — installed, no update source configured (e.g. an install predating ADR-016)
    seedVersion(home);
    const f = stubFetch(() => ({ ok: true, status: 200, text: async () => '// updater source' }));
    let ran = null;
    // when
    try {
      await hook.updateFromRemote(src => {
        ran = src;
      });
    } finally {
      f.restore();
    }
    // then — never touches the network; there is no built-in update source to fall back to
    assert.equal(f.calls.length, 0);
    assert.equal(ran, null);
  });
});

test('updateFromRemote does nothing without a currentVersion', async () => {
  await inSandboxAsync(async (hook) => {
    // given — not installed
    let ran = null;
    const f = stubFetch(() => {
      throw new Error('should not be called');
    });
    // when
    try {
      await hook.updateFromRemote(src => {
        ran = src;
      });
    } finally {
      f.restore();
    }
    // then
    assert.equal(f.calls.length, 0);
    assert.equal(ran, null);
  });
});

test('updateFromRemote refuses to run an HTML error page', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the repo serves an HTML error page instead of source
    seedVersion(home);
    let ran = null;
    const f = stubFetch(() => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html>\nerror' }));
    // when
    try {
      await hook.updateFromRemote(src => {
        ran = src;
      });
    } finally {
      f.restore();
    }
    // then — not run
    assert.equal(ran, null);
  });
});

test('updateFromRemote does nothing on a network failure', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the fetch fails (VPN off)
    seedVersion(home);
    let ran = null;
    const f = stubFetch(() => {
      throw new Error('offline');
    });
    // when
    try {
      await hook.updateFromRemote(src => {
        ran = src;
      });
    } finally {
      f.restore();
    }
    // then — not run; retried next session
    assert.equal(ran, null);
  });
});
