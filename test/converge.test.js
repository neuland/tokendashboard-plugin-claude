'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  inUpdaterSandbox, inUpdaterSandboxAsync, stubFetch, pluginDir, legacyPluginDir, settingsPath,
  hookDest, configPath,
} = require('./helpers.js');
const { version } = require('../package.json');

// converge() is the fetched-run reconcile (see ADR-012): it probes the remote package.json,
// downloads payload files when the remote is newer OR a local file is missing (migration),
// and repoints settings only on drift.

// converge() no longer has a built-in default raw base — every test that expects it to
// actually reach the network configures this test double explicitly (see ADR-016).
const TEST_RAW_BASE = 'https://raw.githubusercontent.com/example/repo/main';

const pkgRes = (v, pluginFiles = ['hook.js']) => ({ ok: true, status: 200, json: async () => ({ version: v, pluginFiles }) });
const fileRes = text => ({ ok: true, status: 200, text: async () => text });

// Route the two request kinds converge makes: package.json (probe) and each pluginFile.
function routes({ pkg, file }) {
  return url => {
    if (url.endsWith('package.json')) {
      return pkg;
    }
    return file;
  };
}

const seedHook = (home, content) => {
  fs.mkdirSync(pluginDir(home), { recursive: true });
  fs.writeFileSync(hookDest(home), content);
};

test('converge makes no request when not installed (no currentVersion)', async () => {
  await inUpdaterSandboxAsync(async updater => {
    // given — no config
    const f = stubFetch(() => {
      throw new Error('should not be called');
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then
    assert.equal(f.calls.length, 0);
  });
});

test('converge leaves config untouched when the probe fails', async () => {
  await inUpdaterSandboxAsync(async updater => {
    // given — installed, but the network is down
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — only the probe was attempted, no lastUpdateCheck recorded
    assert.equal(f.calls.length, 1);
    assert.equal(updater.loadConfig().lastUpdateCheck, undefined);
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
  });
});

test('converge records the check but downloads nothing when up to date', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed at the remote version with the file already present
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    seedHook(home, '// current hook');
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — only package.json fetched; the file is untouched; the check is recorded
    assert.equal(f.calls.length, 1);
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// current hook');
    assert.ok(updater.loadConfig().lastUpdateCheck);
  });
});

test('converge refuses to apply an HTML error page', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a newer remote, but the payload is an HTML error page
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.5.0'), file: fileRes('<!DOCTYPE html>\nerror') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — nothing written, version not bumped
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
  });
});

test('converge refuses a non-JS junk body served with HTTP 200 (JSON error)', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a newer remote, but a proxy/rate-limiter returns a JSON error body with status 200
    // (no doctype, so the old `<!` guard would have accepted it as hook.js).
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.5.0'), file: fileRes('{"message":"rate limited"}') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — nothing written, version NOT bumped (bumping would permanently wedge telemetry)
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
  });
});

test('converge refuses a doctype-less HTML login page served with HTTP 200', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a newer remote, but an SSO gate returns an <html> login page with no doctype.
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.5.0'), file: fileRes('<html><body>Sign in</body></html>') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the compile check rejects it; no file lands, version unchanged
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
  });
});

test('isValidPayload accepts real JS (including a shebang) and rejects junk', () => {
  inUpdaterSandbox(updater => {
    // given/when/then — a shebang'd module is valid; HTML and JSON error bodies are not
    assert.equal(updater.isValidPayload('hook.js', '#!/usr/bin/env node\nconst x = 1;\n'), true);
    assert.equal(updater.isValidPayload('hook.js', 'module.exports = { a: 1 };'), true);
    assert.equal(updater.isValidPayload('hook.js', '<!DOCTYPE html>'), false);
    assert.equal(updater.isValidPayload('hook.js', '<html>nope</html>'), false);
    assert.equal(updater.isValidPayload('hook.js', '{"message":"rate limited"}'), false);
  });
});

test('converge downloads and bumps the version when the remote is newer', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed, remote is newer, file present but stale
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    seedHook(home, '// old hook');
    const f = stubFetch(routes({ pkg: pkgRes('0.5.0'), file: fileRes('// new hook') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — payload replaced, version bumped; no .tmp left behind
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// new hook');
    assert.equal(updater.loadConfig().currentVersion, '0.5.0');
    assert.equal(fs.readdirSync(pluginDir(home)).some(f2 => f2.includes('.tmp')), false);
  });
});

test('converge does NOT record the check when a needed payload download fails', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed, remote is newer, but the pluginFile fetch fails transiently after
    // the package.json probe succeeds (VPN blip, timeout). The 24h throttle must not engage.
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    seedHook(home, '// old hook');
    const f = stubFetch(url => {
      if (url.endsWith('package.json')) {
        return pkgRes('0.5.0');
      }
      return { ok: false, status: 500, text: async () => '' };
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — download did not land, version stays behind, and lastUpdateCheck is NOT stamped
    // so the loader retries next session instead of throttling the available rollout for 24h.
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// old hook');
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
    assert.equal(updater.loadConfig().lastUpdateCheck, undefined);
  });
});

test('converge downloads a missing file even when the version is equal (migration)', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed at the remote version, but the file is NOT at the new path yet
    // (frozen 0.3.5 set currentVersion but delivered the hook to the legacy location).
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0'), file: fileRes('// migrated hook') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the missing file drives the download despite the equal version
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// migrated hook');
  });
});

test('converge does NOT downgrade on a missing file when the remote is older', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed at 0.5.0, hook.js absent (deleted by a cleanup tool), but main was
    // rolled back to 0.4.0. filesMissing is true, yet the remote is OLDER.
    updater.saveConfig({ currentVersion: '0.5.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0'), file: fileRes('// older hook') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the not-older guard blocks the download; no older payload lands, version kept
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().currentVersion, '0.5.0');
  });
});

test('converge flags a migration blocked by an older remote and records the check', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — mid-migration: currentVersion set by the frozen updater, hook.js NOT at the new
    // path, but main was rolled back to an OLDER version. The download is correctly declined.
    updater.saveConfig({ currentVersion: '0.5.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0'), file: fileRes('// older hook') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — reached-the-server-and-declined is recorded: migrationBlocked is set and the check
    // is stamped, so the loader throttles the pending migration instead of storming every session.
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().migrationBlocked, true);
    assert.ok(updater.loadConfig().lastUpdateCheck);
  });
});

test('converge clears migrationBlocked once the migration converges', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a previously-blocked migration, now the remote has rolled forward and the payload
    // downloads cleanly (files land at the canonical path).
    updater.saveConfig({ currentVersion: '0.4.0', migrationBlocked: true, repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0'), file: fileRes('// migrated hook') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the file landed and the stale flag is cleared, restoring the normal throttle path
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// migrated hook');
    assert.equal(updater.loadConfig().migrationBlocked, false);
  });
});

test('converge aborts (no download, no repoint) if currentVersion is cleared mid-fetch', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed with stale hook + drifted settings; a concurrent uninstall clears
    // config.json (currentVersion) during converge's package.json probe.
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    seedHook(home, '// stale hook');
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js"' }] }] },
    }, null, 2));
    const before = fs.readFileSync(settingsPath(home), 'utf8');
    const f = stubFetch(url => {
      if (url.endsWith('package.json')) {
        fs.rmSync(configPath(home)); // simulate a parallel uninstall landing here
        return pkgRes('0.5.0');
      }
      return fileRes('// new hook');
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — only the probe ran; the stale hook and drifted settings are left untouched (the
    // uninstall is not reverted)
    assert.equal(f.calls.length, 1);
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// stale hook');
    assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), before);
  });
});

test('converge aborts the publish if currentVersion is cleared during the file download', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — newer remote so converge reaches downloadPluginFiles; a concurrent uninstall
    // clears config.json during the payload fetch (AFTER the post-probe re-check passed).
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    const f = stubFetch(url => {
      if (url.endsWith('package.json')) {
        return pkgRes('0.5.0');
      }
      fs.rmSync(configPath(home)); // uninstall lands mid-download
      return fileRes('// new hook');
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the publish guard aborts: no file materialized, version not bumped, no .tmp left
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(updater.loadConfig().currentVersion, undefined);
    assert.equal(fs.existsSync(configPath(home)), false);
  });
});

test('converge repoints legacy settings to the new path on drift', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed, file present, but settings still point at the legacy path
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    seedHook(home, '// hook');
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js"' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js" --flush' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js" --check-update' }] }],
      },
    }, null, 2));
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — legacy path is gone, our entries now point at the plugin-dir path
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.ok(!JSON.stringify(settings).includes('hooks/token-usage-plugin.js'));
    assert.ok(updater.hooksAreCurrent(settings));
  });
});

test('converge performs ZERO settings writes in steady state (load-bearing)', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a correct install (settings + file + config all current)
    updater.install(version, 'https://ingest.example/test', TEST_RAW_BASE);
    // Stamp settings.json with a distinct past mtime so any rewrite would move it forward.
    const past = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(settingsPath(home), past, past);
    const before = fs.statSync(settingsPath(home)).mtimeMs;
    const f = stubFetch(routes({ pkg: pkgRes(version) }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — settings.json was not written at all (mtime unchanged); this is what makes
    // the automatic settings write safe against concurrent writers (see ADR-012).
    assert.equal(fs.statSync(settingsPath(home)).mtimeMs, before);
  });
});

test('converge is a no-op while another session holds the update lock', async () => {
  await inUpdaterSandboxAsync(async updater => {
    // given — installed, and a concurrent session already holds the update lock
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    assert.equal(updater.acquireUpdateLock(), true);
    const f = stubFetch(() => {
      throw new Error('should not be called while lock is held');
    });
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
      updater.releaseUpdateLock();
    }
    // then — the thundering-herd guard prevents a second concurrent fetch
    assert.equal(f.calls.length, 0);
  });
});

test('converge does NOT repoint settings when the hook download fails (no stranding)', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — mid-migration: version set by the frozen updater, hook.js NOT at the new path,
    // legacy settings still on disk. package.json probes fine but the hook.js fetch fails.
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: TEST_RAW_BASE });
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js"' }] }] },
    }, null, 2));
    const f = stubFetch(url => (url.endsWith('package.json') ? pkgRes('0.4.0') : { ok: false, status: 500 }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — hook.js was never written, and settings were NOT repointed to the missing file;
    // the legacy path survives so the install keeps working instead of being stranded.
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.ok(fs.readFileSync(settingsPath(home), 'utf8').includes('hooks/token-usage-plugin.js'));
  });
});

test('acquireUpdateLock steals an empty/corrupt lock file', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a zero-byte lock (a crash between the wx-create and the pid write)
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(home), '.update.lock'), '');
    // when
    const got = updater.acquireUpdateLock();
    // then — the empty lock is stolen, not mistaken for a live owner (which would block
    // every future update forever)
    assert.equal(got, true);
    updater.releaseUpdateLock();
  });
});

test('converge fetches from the configured repoRawBaseUrl when present', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed with a configured update source
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: 'https://raw.githubusercontent.com/foo/bar/main' });
    seedHook(home, '// hook');
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — the probe URL is built from the configured base
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://raw.githubusercontent.com/foo/bar/main/package.json');
  });
});

test('converge is a no-op when repoRawBaseUrl is not configured — no fallback default (ADR-016)', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — installed, but no update source configured (e.g. an install predating ADR-016)
    updater.saveConfig({ currentVersion: '0.4.0' });
    seedHook(home, '// hook');
    const f = stubFetch(routes({ pkg: pkgRes('0.5.0') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — never touches the network or the installed file; there is no built-in
    // update source to fall back to
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// hook');
    assert.equal(updater.loadConfig().currentVersion, '0.4.0');
  });
});

test('converge strips a trailing slash from a configured repoRawBaseUrl to avoid a double-slash URL', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a configured base with a trailing slash
    updater.saveConfig({ currentVersion: '0.4.0', repoRawBaseUrl: 'https://raw.githubusercontent.com/foo/bar/main/' });
    seedHook(home, '// hook');
    const f = stubFetch(routes({ pkg: pkgRes('0.4.0') }));
    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }
    // then — no double slash before package.json
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://raw.githubusercontent.com/foo/bar/main/package.json');
  });
});

// Guard against an accidental reference to configPath breaking (used by other suites).
test('configPath helper points inside the plugin dir', () => {
  // given a base dir, when configPath derives the config location, then it sits in the plugin dir
  assert.ok(configPath('/x').includes(path.join('tokendashboard-plugin', 'config.json')));
});

// --- Pre-0.8.0 dir rename (see ADR-018) ---

// An existing install is only visible to converge through config.json, which after the
// rename sits in the OLD dir — adoption is what keeps the migration from silently never
// happening for every already-installed user.

const seedLegacyInstall = (home, config, userId) => {
  fs.mkdirSync(legacyPluginDir(home), { recursive: true });
  fs.writeFileSync(path.join(legacyPluginDir(home), 'config.json'), JSON.stringify(config, null, 2));
  if (userId) {
    fs.writeFileSync(path.join(legacyPluginDir(home), 'user-id'), userId);
  }
};

test('converge adopts a pre-0.8.0 install and migrates it into the new plugin dir', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a 0.7.0 install: config + user-id in the old dir, settings pointing at the
    // old hook path, and nothing at all in the new dir.
    seedLegacyInstall(home, { currentVersion: '0.7.0', repoRawBaseUrl: TEST_RAW_BASE }, 'uuid-from-0.7.0');
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/token-usage-plugin/hook.js"' }] }] },
      statusLine: { type: 'command', command: 'node "$HOME/.claude/token-usage-plugin/statusline.js"' },
    }, null, 2));
    const f = stubFetch(routes({ pkg: pkgRes('0.8.0'), file: fileRes('// renamed hook') }));

    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — payload landed in the new dir, version bumped, identity carried over
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), '// renamed hook');
    assert.equal(updater.loadConfig().currentVersion, '0.8.0');
    assert.equal(fs.readFileSync(path.join(pluginDir(home), 'user-id'), 'utf8'), 'uuid-from-0.7.0');
    // and — settings repointed to the new dir, with the old entry gone (no double hook)
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.hooks.Stop.length, 1);
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes('tokendashboard-plugin/hook.js'));
    assert.ok(!JSON.stringify(settings).includes('token-usage-plugin/hook.js'));
    // and — statusLine moved too, or it would keep rendering the frozen old script
    assert.ok(settings.statusLine.command.includes('tokendashboard-plugin/statusline.js'));
  });
});

test('converge does not adopt a pre-0.8.0 config left behind by an uninstall', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — an old-dir config with no currentVersion (uninstalled under the old layout)
    seedLegacyInstall(home, { apiBaseUrl: 'https://example.test' });
    const f = stubFetch(routes({ pkg: pkgRes('0.8.0'), file: fileRes('// hook') }));

    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — no request, and nothing created in the new dir
    assert.equal(f.calls.length, 0);
    assert.ok(!fs.existsSync(configPath(home)));
  });
});

test('converge does not revive an install once uninstall has cleared both configs', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — an adopted install (both configs present), then an uninstall clearing both.
    // Leaving the old config behind here is what would let adoption resurrect the install.
    seedLegacyInstall(home, { currentVersion: '0.7.0', repoRawBaseUrl: TEST_RAW_BASE });
    updater.adoptLegacyInstall();
    assert.equal(updater.loadConfig().currentVersion, '0.7.0'); // adopted
    updater.uninstall();

    // when
    const f = stubFetch(routes({ pkg: pkgRes('0.8.0'), file: fileRes('// hook') }));
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — no request, and adoption did not re-materialize config.json
    assert.equal(f.calls.length, 0);
    assert.ok(!fs.existsSync(configPath(home)));
  });
});

test('converge leaves a foreign statusLine alone and writes nothing when already current', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a fully converged install whose statusLine belongs to someone else
    updater.install(version, 'https://api.test', TEST_RAW_BASE);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node "$HOME/my-bar.js"' };
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2) + '\n');
    const before = fs.readFileSync(settingsPath(home), 'utf8');

    // when
    const f = stubFetch(routes({ pkg: pkgRes(version), file: fileRes('// hook') }));
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — steady state: settings.json is byte-identical, the foreign bar survives
    assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), before);
    assert.ok(before.includes('my-bar.js'));
  });
});

test('converge does not add a statusLine that the user removed on purpose', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — converged install with the statusLine entry deleted (the documented
    // "keep the plugin, drop the statusline" state)
    updater.install(version, 'https://api.test', TEST_RAW_BASE);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    delete settings.statusLine;
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2) + '\n');
    const before = fs.readFileSync(settingsPath(home), 'utf8');

    // when
    const f = stubFetch(routes({ pkg: pkgRes(version), file: fileRes('// hook') }));
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — still absent, and no write happened
    assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), before);
    assert.ok(!before.includes('statusLine'));
  });
});

test('converge leaves settings pointing at the old path when the migration download fails', async () => {
  await inUpdaterSandboxAsync(async (updater, home) => {
    // given — a pre-0.8.0 install adopted, but the payload fetch fails (VPN dropped)
    seedLegacyInstall(home, { currentVersion: '0.7.0', repoRawBaseUrl: TEST_RAW_BASE });
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/token-usage-plugin/hook.js"' }] }] },
    }, null, 2));
    const before = fs.readFileSync(settingsPath(home), 'utf8');
    const f = stubFetch(routes({ pkg: pkgRes('0.8.0'), file: { ok: false, status: 502, text: async () => '' } }));

    // when
    try {
      await updater.converge();
    } finally {
      f.restore();
    }

    // then — no payload, settings still point at the still-working old hook, and no
    // lastUpdateCheck stamp, so the next session retries instead of throttling
    assert.ok(!fs.existsSync(hookDest(home)));
    assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), before);
    assert.equal(updater.loadConfig().lastUpdateCheck, undefined);
  });
});
