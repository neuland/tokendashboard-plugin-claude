'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { inUpdaterSandbox, withTempHome, settingsPath, hookDest, statuslineDest, configPath } = require('./helpers.js');
const { version } = require('../package.json');

const UPDATER_PATH = require.resolve('../updater.js');

// install/uninstall live in updater.js, which is also the npx `bin` entry (see ADR-012).

const EVENTS = ['Stop', 'SessionEnd', 'SessionStart', 'SubagentStop'];

// How the hook is referenced in a command: $HOME-relative on a POSIX shell when the hook
// lives under home, absolute otherwise (Windows / custom config dir).
const hookRef = home => process.platform === 'win32'
  ? hookDest(home)
  : '$HOME/.claude/token-usage-plugin/hook.js';

const readSettings = home => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));

function seedSettings(home, settings) {
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));
}

test('install copies the hook, writes config, and registers all four events', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a fresh sandbox

    // when
    updater.install(version);

    // then — hook file exists under the plugin dir, config carries the version, all events registered
    assert.equal(fs.existsSync(hookDest(home)), true);

    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.currentVersion, version);
    assert.ok(config.lastUpdateCheck);

    const settings = readSettings(home);
    for (const event of EVENTS) {
      assert.equal(settings.hooks[event].length, 1);
      const cmd = settings.hooks[event][0].hooks[0].command;
      assert.ok(cmd.includes(hookRef(home)), `${event} command points at the hook`);
    }
  });
});

test('install writes $HOME-relative commands on POSIX, not the absolute home path', { skip: process.platform === 'win32' }, () => {
  inUpdaterSandbox((updater, home) => {
    // given — a fresh sandbox

    // when
    updater.install(version);

    // then — commands reference the hook via $HOME so a mounted ~/.claude stays valid
    // across environments (host vs devcontainer); the absolute home prefix must not appear.
    const settings = readSettings(home);
    for (const event of EVENTS) {
      const cmd = settings.hooks[event][0].hooks[0].command;
      assert.ok(cmd.includes('$HOME/.claude/token-usage-plugin/hook.js'), `${event} uses $HOME`);
      assert.ok(!cmd.includes(home), `${event} does not hardcode the absolute home path`);
    }
  });
});

test('install is idempotent — repeated runs never duplicate own entries', () => {
  inUpdaterSandbox((updater, home) => {
    // given / when — install three times
    updater.install(version);
    updater.install(version);
    updater.install(version);

    // then — still exactly one entry per event
    const settings = readSettings(home);
    for (const event of EVENTS) {
      assert.equal(settings.hooks[event].length, 1);
    }
  });
});

test('install preserves foreign hooks and unrelated settings', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a pre-existing foreign Stop hook and an unrelated setting
    seedSettings(home, {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] },
    });

    // when
    updater.install(version);

    // then — foreign Stop entry kept alongside ours; permissions untouched
    const settings = readSettings(home);
    assert.equal(settings.permissions.allow[0], 'Bash');
    assert.equal(settings.hooks.Stop.length, 2);
    const commands = settings.hooks.Stop.flatMap(e => e.hooks).map(h => h.command);
    assert.ok(commands.includes('echo foreign'));
    assert.ok(commands.some(c => c.includes(hookRef(home))));
  });
});

test('install migrates a legacy (pre-0.4.0) settings entry to the new path', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a legacy entry pointing at the old ~/.claude/hooks location
    seedSettings(home, {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/token-usage-plugin.js"' }] }],
      },
    });

    // when
    updater.install(version);

    // then — exactly one Stop entry, now at the new path; the legacy path is gone
    const settings = readSettings(home);
    assert.equal(settings.hooks.Stop.length, 1);
    assert.ok(!JSON.stringify(settings).includes('hooks/token-usage-plugin.js'));
    assert.ok(settings.hooks.Stop[0].hooks[0].command.includes(hookRef(home)));
  });
});

test('install does not delete an unrelated hook that merely shares the name prefix', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a foreign hook whose command contains `token-usage-plugin` only as a prefix
    seedSettings(home, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/tools/tokendashboard-plugin-exporter.js"' }] }] },
    });

    // when
    updater.install(version);

    // then — the exporter survives alongside ours; the matcher is not a bare substring
    const settings = readSettings(home);
    const commands = settings.hooks.Stop.flatMap(e => e.hooks).map(h => h.command);
    assert.ok(commands.some(c => c.includes('tokendashboard-plugin-exporter.js')), 'exporter preserved');
    assert.ok(commands.some(c => c.includes(hookRef(home))), 'our hook added');
    assert.equal(settings.hooks.Stop.length, 2);
  });
});

test('uninstall refuses to proceed on an unparseable settings.json (leaves files intact)', () => {
  inUpdaterSandbox((updater, home) => {
    // given — an installed plugin, then a corrupt settings.json
    updater.install(version);
    fs.writeFileSync(settingsPath(home), '{ broken json');
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = code => {
      throw new Error(`exit:${code}`);
    };
    console.error = () => {};

    // when / then — uninstall aborts BEFORE deleting the hook file, so no dangling entries
    try {
      assert.throws(() => updater.uninstall(), /exit:1/);
      assert.equal(fs.existsSync(hookDest(home)), true, 'hook file not deleted on corrupt settings');
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

test('uninstall removes the hook file and our entries but keeps foreign hooks', () => {
  inUpdaterSandbox((updater, home) => {
    // given — our hooks installed, plus a foreign Stop hook added afterwards
    updater.install(version);
    const settings = readSettings(home);
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo foreign' }] });
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));

    // when
    updater.uninstall();

    // then — hook file gone, foreign Stop survives, our other events removed entirely
    assert.equal(fs.existsSync(hookDest(home)), false);
    const after = readSettings(home);
    assert.equal(after.hooks.Stop.length, 1);
    assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo foreign');
    assert.equal(after.hooks.SessionEnd, undefined);
    assert.equal(after.hooks.SessionStart, undefined);
    assert.equal(after.hooks.SubagentStop, undefined);
  });
});

test('uninstall also removes a leftover legacy hook file', () => {
  inUpdaterSandbox((updater) => {
    // given — an installed plugin plus an orphaned legacy file (never auto-deleted by converge)
    updater.install(version);
    fs.mkdirSync(path.dirname(updater.LEGACY_HOOK_DEST), { recursive: true });
    fs.writeFileSync(updater.LEGACY_HOOK_DEST, '// old');

    // when
    updater.uninstall();

    // then — the legacy file is cleaned up on explicit uninstall
    assert.equal(fs.existsSync(updater.LEGACY_HOOK_DEST), false);
  });
});

test('uninstall clears currentVersion (removes config.json) so an in-flight converge aborts', () => {
  inUpdaterSandbox((updater, home) => {
    // given — an installed plugin with config.json holding currentVersion
    updater.install(version);
    assert.equal(fs.existsSync(configPath(home)), true);

    // when
    updater.uninstall();

    // then — config.json is gone; converge's existence guard (currentVersion) no longer passes
    assert.equal(fs.existsSync(configPath(home)), false);
    assert.equal(updater.loadConfig().currentVersion, undefined);
  });
});

test('uninstall drops the empty hooks object when nothing else remains', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a clean install with no foreign hooks
    updater.install(version);

    // when
    updater.uninstall();

    // then — hooks key removed entirely
    const settings = readSettings(home);
    assert.equal(settings.hooks, undefined);
  });
});

test('install honors CLAUDE_CONFIG_DIR over ~/.claude', () => {
  // given — CLAUDE_CONFIG_DIR points at a custom dir, resolved before the module loads
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-cfg-'));
  try {
    inUpdaterSandbox((updater, home) => {
      // when
      updater.install(version);

      // then — hook, settings, and commands all live under the override, not ~/.claude
      const customHook = path.join(configDir, 'token-usage-plugin', 'hook.js');
      const customSettings = path.join(configDir, 'settings.json');
      assert.equal(fs.existsSync(customHook), true);
      assert.equal(fs.existsSync(hookDest(home)), false, 'nothing written under ~/.claude');

      const settings = JSON.parse(fs.readFileSync(customSettings, 'utf8'));
      for (const event of EVENTS) {
        assert.ok(settings.hooks[event][0].hooks[0].command.includes(customHook));
      }
    }, { configDir });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('run dispatches "install" and "uninstall"', () => {
  inUpdaterSandbox((updater, home) => {
    // given / when — install via run
    updater.run('install', version);
    // then
    assert.equal(fs.existsSync(hookDest(home)), true);

    // when — uninstall via run
    updater.run('uninstall');
    // then
    assert.equal(fs.existsSync(hookDest(home)), false);
  });
});

test('run exits with an error on an unknown command', () => {
  inUpdaterSandbox(updater => {
    // given — process.exit and console.error stubbed so the test survives
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = code => {
      throw new Error(`exit:${code}`);
    };
    console.error = () => {};

    // when / then — an unknown command exits non-zero
    try {
      assert.throws(() => updater.run('frobnicate'), /exit:1/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

test('install refuses to clobber an unparseable settings.json', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a corrupt settings.json
    seedSettings(home, {});
    fs.writeFileSync(settingsPath(home), '{ broken json');
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = code => {
      throw new Error(`exit:${code}`);
    };
    console.error = () => {};

    // when / then — install bails out rather than overwriting the malformed file
    try {
      assert.throws(() => updater.install(version), /exit:1/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

test('the npx bin entry (node updater.js install) installs the hook', () => {
  // given — an isolated $HOME; updater.js is the registered `bin`, so npx runs it directly
  const { home, cleanup } = withTempHome();
  try {
    // when — invoke it as a child process exactly as npx would (main()'s argv dispatch)
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — the process succeeded and the hook was installed under the plugin dir
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(hookDest(home)), true);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  } finally {
    cleanup();
  }
});

test('the npx bin entry fails loudly without --api-base-url', () => {
  // given — an isolated $HOME, no --api-base-url passed (but --repo-raw-base-url is)
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--api-base-url/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('the npx bin entry fails loudly without --repo-raw-base-url', () => {
  // given — an isolated $HOME, no --repo-raw-base-url passed (but --api-base-url is)
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install', '--api-base-url', 'https://example.test',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--repo-raw-base-url/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('the npx bin entry reinstall without either flag fails — no fallback to a stored value', () => {
  // given — a first install with both flags configured
  const { home, cleanup } = withTempHome();
  try {
    const first = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(first.status, 0, first.stderr);

    // when — reinstalling (e.g. settings.json got wiped/reset) without repeating either flag
    const second = spawnSync(process.execPath, [UPDATER_PATH, 'install'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — fails loudly; config.json is untouched, still holding the first install's values
    assert.notEqual(second.status, 0);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  } finally {
    cleanup();
  }
});

test('isPlausibleUrl accepts http(s) URLs with a path and rejects everything else (repoRawBaseUrl-style, requirePath default)', () => {
  inUpdaterSandbox(updater => {
    // given / when / then
    assert.equal(updater.isPlausibleUrl('https://example.test/ingest/claude'), true);
    assert.equal(updater.isPlausibleUrl('http://example.test/ingest'), false);
    assert.equal(updater.isPlausibleUrl('http://localhost/ingest'), true);
    assert.equal(updater.isPlausibleUrl('http://127.0.0.1:3000/ingest'), true);
    // a bare origin with no path is never valid for a flag whose value needs a specific
    // route (e.g. --repo-raw-base-url's raw-file path) — the default requirePath: true
    assert.equal(updater.isPlausibleUrl('https://example.test'), false);
    assert.equal(updater.isPlausibleUrl('https://example.test/'), false);
    assert.equal(updater.isPlausibleUrl('anything'), false);
    assert.equal(updater.isPlausibleUrl('ftp://example.test/ingest'), false);
    assert.equal(updater.isPlausibleUrl(''), false);
  });
});

test('isPlausibleUrl accepts a bare origin when requirePath is false (--api-base-url)', () => {
  inUpdaterSandbox(updater => {
    // given / when / then — hook.js appends fixed route suffixes to this value, so a bare
    // origin (no path at all) is a valid --api-base-url, unlike --repo-raw-base-url
    assert.equal(updater.isPlausibleUrl('https://example.test', { requirePath: false }), true);
    assert.equal(updater.isPlausibleUrl('https://example.test/api', { requirePath: false }), true);
    assert.equal(updater.isPlausibleUrl('anything', { requirePath: false }), false);
    assert.equal(updater.isPlausibleUrl('ftp://example.test', { requirePath: false }), false);
    assert.equal(updater.isPlausibleUrl('', { requirePath: false }), false);
  });
});

test('the npx bin entry rejects an implausible --api-base-url (e.g. "anything")', () => {
  // given — an isolated $HOME, a non-URL --api-base-url value
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'anything',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /valid http\(s\) URLs/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('parseApiBaseUrlArg reads both --api-base-url <url> and --api-base-url=<url> forms', () => {
  inUpdaterSandbox(updater => {
    // given / when / then
    assert.equal(updater.parseApiBaseUrlArg(['install', '--api-base-url', 'https://a.test']), 'https://a.test');
    assert.equal(updater.parseApiBaseUrlArg(['install', '--api-base-url=https://b.test']), 'https://b.test');
    assert.equal(updater.parseApiBaseUrlArg(['install']), undefined);
  });
});

test('parseRepoUrlArg reads both --repo-raw-base-url <url> and --repo-raw-base-url=<url> forms, and is undefined when omitted', () => {
  inUpdaterSandbox(updater => {
    // given / when / then
    assert.equal(
      updater.parseRepoUrlArg(['install', '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main']),
      'https://raw.githubusercontent.com/foo/bar/main'
    );
    assert.equal(
      updater.parseRepoUrlArg(['install', '--repo-raw-base-url=https://raw.githubusercontent.com/foo/bar/main']),
      'https://raw.githubusercontent.com/foo/bar/main'
    );
    assert.equal(updater.parseRepoUrlArg(['install']), undefined);
  });
});

test('extractCommand skips a value-flag\'s separate-token value instead of misparsing it as the command', () => {
  inUpdaterSandbox(updater => {
    // given / when / then — the explicit command wins when present
    assert.equal(updater.extractCommand(['install', '--api-base-url', 'https://a.test']), 'install');
    // the URL after a known value-flag is not mistaken for the command, even with no
    // command word at all (a bare `npx <pkg> --api-base-url <url>` invocation)
    assert.equal(updater.extractCommand(['--api-base-url', 'https://a.test']), undefined);
    assert.equal(
      updater.extractCommand(['--api-base-url', 'https://a.test', '--repo-raw-base-url', 'https://b.test']),
      undefined
    );
    // the `--flag=value` form has no separate value token to skip
    assert.equal(updater.extractCommand(['--api-base-url=https://a.test']), undefined);
    assert.equal(updater.extractCommand(['uninstall']), 'uninstall');
  });
});

test('the npx bin entry stores --repo-raw-base-url when passed', () => {
  // given — an isolated $HOME
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then
    assert.equal(res.status, 0, res.stderr);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  } finally {
    cleanup();
  }
});

test('the npx bin entry accepts a bare-origin --api-base-url (no path)', () => {
  // given — an isolated $HOME; --api-base-url has fixed routes appended by hook.js, so a
  // bare origin (or an origin plus a non-route path prefix) is valid, unlike --repo-raw-base-url
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then
    assert.equal(res.status, 0, res.stderr);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
  } finally {
    cleanup();
  }
});

// Run a copy of updater.js from a scratch dir whose package.json is missing or malformed,
// so `require('./package.json')` in main() resolves next to the copy (not the repo).
function runInstallWithPackageJson(pkgContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-pkg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-test-'));
  fs.copyFileSync(UPDATER_PATH, path.join(dir, 'updater.js'));
  if (pkgContent !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), pkgContent);
  }
  try {
    const res = spawnSync(process.execPath, [path.join(dir, 'updater.js'), 'install'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { res, home };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('install fails loudly when package.json is missing (no silent frozen install)', () => {
  // given / when — a bare updater.js with no package.json beside it
  const { res, home } = runInstallWithPackageJson(null);

  // then — non-zero exit, an explanatory error, and nothing installed (rather than a config
  // with currentVersion: undefined that can never auto-update or migrate)
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Cannot read package\.json/);
  assert.equal(fs.existsSync(hookDest(home)), false);
});

test('install fails loudly when package.json has no version field', () => {
  // given / when — a package.json that parses but carries no version
  const { res, home } = runInstallWithPackageJson('{"name":"x"}');

  // then — non-zero exit with a clear message; nothing installed
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no version field/);
  assert.equal(fs.existsSync(hookDest(home)), false);
});

// statusLine install/uninstall (ported from the removed cli.js/cli.test.js — see ADR-012).

const statuslineRef = home => process.platform === 'win32'
  ? statuslineDest(home)
  : '$HOME/.claude/token-usage-plugin/statusline.js';

test('install copies the statusline script and registers it', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a fresh sandbox

    // when
    updater.install(version);

    // then
    assert.equal(fs.existsSync(statuslineDest(home)), true);
    const settings = readSettings(home);
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes(statuslineRef(home)));
  });
});

test('install is idempotent for the statusline registration too', () => {
  inUpdaterSandbox((updater, home) => {
    // given / when — install three times
    updater.install(version);
    updater.install(version);
    updater.install(version);

    // then — still a single statusLine entry pointing at our script
    const settings = readSettings(home);
    assert.ok(settings.statusLine.command.includes(statuslineRef(home)));
  });
});

test('install leaves a foreign statusLine untouched', () => {
  inUpdaterSandbox((updater, home) => {
    // given — the user (or another plugin) already configured a statusLine
    seedSettings(home, { statusLine: { type: 'command', command: 'echo foreign-statusline' } });

    // when
    updater.install(version);

    // then — hooks still get registered, but the foreign statusLine survives
    const settings = readSettings(home);
    assert.equal(settings.statusLine.command, 'echo foreign-statusline');
    for (const event of EVENTS) {
      assert.equal(settings.hooks[event].length, 1);
    }
  });
});

test('uninstall removes the statusline script and our registration, keeping a foreign one', () => {
  inUpdaterSandbox((updater, home) => {
    // given — installed, then the statusLine is manually swapped for a foreign one
    updater.install(version);
    const settings = readSettings(home);
    settings.statusLine = { type: 'command', command: 'echo foreign-statusline' };
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));

    // when
    updater.uninstall();

    // then — our script file is gone, but the (now foreign) statusLine setting is untouched
    assert.equal(fs.existsSync(statuslineDest(home)), false);
    const after = readSettings(home);
    assert.equal(after.statusLine.command, 'echo foreign-statusline');
  });
});

test('uninstall clears our own statusLine registration', () => {
  inUpdaterSandbox((updater, home) => {
    // given — a clean install
    updater.install(version);

    // when
    updater.uninstall();

    // then
    const settings = readSettings(home);
    assert.equal(settings.statusLine, undefined);
  });
});
