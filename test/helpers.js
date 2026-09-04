'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_PATH = require.resolve('../hook.js');
const UPDATER_PATH = require.resolve('../updater.js');
const STATUSLINE_PATH = require.resolve('../statusline.js');

// Create an isolated temp directory and point $HOME at it, so the plugin's
// ~/.claude/* path constants (computed at module load from os.homedir()) resolve
// inside the sandbox. Returns { home, cleanup }.
function withTempHome(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows fallback for os.homedir()
  // Isolate CLAUDE_CONFIG_DIR: clear an inherited value by default so the dev's own
  // env can't skew path resolution; set it when a test exercises the override.
  if (opts.configDir) {
    process.env.CLAUDE_CONFIG_DIR = opts.configDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  function cleanup() {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { home, cleanup };
}

// Load a fresh copy of hook.js so its module-level path constants pick up the
// current $HOME. Must be called AFTER withTempHome().
function loadHook() {
  delete require.cache[HOOK_PATH];
  return require(HOOK_PATH);
}

const pluginDir = home => path.join(home, '.claude', 'tokendashboard-plugin');
// Pre-0.8.0 data dir, kept only so migration tests can seed it (see ADR-018).
const legacyPluginDir = home => path.join(home, '.claude', 'token-usage-plugin');
const queueDir = home => path.join(pluginDir(home), 'queue');
const settingsPath = home => path.join(home, '.claude', 'settings.json');
// The hook now lives directly under the plugin dir (see ADR-012). hookDest is the
// canonical location; legacyHookDest is the pre-0.4.0 path we migrate away from.
const hookDest = home => path.join(pluginDir(home), 'hook.js');
const legacyHookDest = home => path.join(home, '.claude', 'hooks', 'token-usage-plugin.js');
// statusline.js lives alongside hook.js under the plugin dir — a pluginFiles entry like
// hook.js, auto-updated the same way, and installed/uninstalled by updater.js (see
// ADR-012, CLAUDE.md).
const statuslineDest = home => path.join(pluginDir(home), 'statusline.js');
const configPath = home => path.join(pluginDir(home), 'config.json');
const errorLogPath = home => path.join(pluginDir(home), 'error.log');
const pricesPath = home => path.join(pluginDir(home), 'prices.json');

// Load a fresh copy of statusline.js so its module-level path constants pick up the
// current $HOME. Must be called AFTER withTempHome().
function loadStatusline() {
  delete require.cache[STATUSLINE_PATH];
  return require(STATUSLINE_PATH);
}

// Run fn against a freshly loaded statusline module inside an isolated temp $HOME.
// fn receives (statusline, home).
function inStatuslineSandbox(fn) {
  const { home, cleanup } = withTempHome();
  const statusline = loadStatusline();
  try {
    return fn(statusline, home);
  } finally {
    cleanup();
  }
}

// API base URL used to seed config.json in hook sandboxes — flush() now refuses to send
// without one (see ADR-016), so hook tests need it present unless a test is
// specifically exercising the no-base-url-configured behavior. hook.js appends fixed route
// suffixes (INGEST_PATH/PRICES_ROUTE) to this base.
const TEST_API_BASE_URL = 'https://example.test';

function seedApiBaseUrl(home) {
  fs.mkdirSync(pluginDir(home), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ apiBaseUrl: TEST_API_BASE_URL }));
}

// Load a fresh copy of updater.js so its module-level path constants pick up the current
// $HOME. Must be called AFTER withTempHome().
function loadUpdater() {
  delete require.cache[UPDATER_PATH];
  return require(UPDATER_PATH);
}

// Shared setup for the updater sandboxes: isolated temp $HOME, a freshly loaded updater
// module, and console.log muted (install/uninstall are chatty). Returns the loaded module,
// the home dir, and a teardown that restores console.log and removes the temp home. The
// sync/async wrappers differ ONLY in whether they await fn — everything else lives here so
// a change to the sandbox (e.g. also muting console.error) can't drift between them.
function setupUpdaterSandbox(opts = {}) {
  const { home, cleanup } = withTempHome(opts);
  const updater = loadUpdater();
  const origLog = console.log;
  console.log = () => {};
  const teardown = () => {
    console.log = origLog;
    cleanup();
  };
  return { updater, home, teardown };
}

// Run fn against a freshly loaded updater module inside an isolated temp $HOME.
// fn receives (updater, home).
function inUpdaterSandbox(fn, opts = {}) {
  const { updater, home, teardown } = setupUpdaterSandbox(opts);
  try {
    return fn(updater, home);
  } finally {
    teardown();
  }
}

// Async variant — awaits fn before teardown, so converge()'s promise resolves inside the
// sandbox rather than after it is torn down.
async function inUpdaterSandboxAsync(fn, opts = {}) {
  const { updater, home, teardown } = setupUpdaterSandbox(opts);
  try {
    return await fn(updater, home);
  } finally {
    teardown();
  }
}

// Run fn against a freshly loaded hook module inside an isolated temp $HOME,
// guaranteeing cleanup. fn receives (hook, home).
function inSandbox(fn) {
  const { home, cleanup } = withTempHome();
  const hook = loadHook();
  try {
    return fn(hook, home);
  } finally {
    cleanup();
  }
}

// Async variant of inSandbox. fn receives (hook, home).
async function inSandboxAsync(fn) {
  const { home, cleanup } = withTempHome();
  delete require.cache[HOOK_PATH];
  const hook = require(HOOK_PATH);
  try {
    return await fn(hook, home);
  } finally {
    cleanup();
  }
}

// flush() now refuses to send without a configured API base URL (see ADR-016) —
// seed one so flush tests exercise the send path unless they're specifically testing the
// no-base-url case. fn receives (hook, home).
async function inFlushSandbox(fn) {
  return inSandboxAsync(async (hook, home) => {
    seedApiBaseUrl(home);
    return fn(hook, home);
  });
}

// Read and parse every queued entry, sorted by model so callers can destructure the
// result deterministically regardless of write order. Accepts either a loaded hook
// module (in-process tests → uses its getQueueFiles) or a home-dir string
// (child-process tests, where no module is loaded → reads the queue dir directly).
function readQueue(hookOrHome) {
  const files = typeof hookOrHome === 'string'
    ? (fs.existsSync(queueDir(hookOrHome))
      ? fs.readdirSync(queueDir(hookOrHome))
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(queueDir(hookOrHome), f))
      : [])
    : hookOrHome.getQueueFiles();
  return files
    .map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
    .sort((a, b) => a.model.localeCompare(b.model));
}

// Replace global.fetch with a recording stub for the duration of a test.
// handler(url, options, callIndex) returns a Response-like object, or throws to
// simulate a network failure (which hook.js's fetchWithTimeout maps to null).
// Returns { calls, restore }.
function stubFetch(handler) {
  const prev = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  return { calls, restore: () => {
    global.fetch = prev;
  } };
}

// Run the real hook.js as a child process (exercising main()'s argv dispatch and
// stdin handling) with $HOME pointed at the sandbox. Returns the spawnSync result
// ({ status, stdout, stderr }). Only use with network-safe modes — see main.test.js.
function runHookProcess(args, { home, input = '' } = {}) {
  return spawnSync(process.execPath, [HOOK_PATH, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

// Run the real statusline.js as a child process (exercising its stdin/stdout main()),
// with $HOME pointed at the sandbox.
function runStatuslineProcess({ home, input = '' } = {}) {
  return spawnSync(process.execPath, [STATUSLINE_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

module.exports = {
  withTempHome,
  loadHook,
  loadUpdater,
  loadStatusline,
  inSandbox,
  inSandboxAsync,
  inFlushSandbox,
  inUpdaterSandbox,
  inUpdaterSandboxAsync,
  inStatuslineSandbox,
  readQueue,
  stubFetch,
  runHookProcess,
  runStatuslineProcess,
  pluginDir,
  legacyPluginDir,
  queueDir,
  settingsPath,
  hookDest,
  legacyHookDest,
  statuslineDest,
  configPath,
  TEST_API_BASE_URL,
  errorLogPath,
  pricesPath,
};
