#!/usr/bin/env node

'use strict';

// All lifecycle logic: install/uninstall (the npx `bin` entry) and converge (fetched fresh
// from the configured repo and run via stdin by hook.js's loader — see ADR-012). Not a
// durable installed file, so a bug here is fixed server-side on the next session rather
// than stranding an install. hook.js contains only capture/flush/loader; the two files
// duplicate a small utility floor (path constants, atomicWriteSync, fetchWithTimeout,
// semver) rather than sharing code.

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

// Mirror Claude Code's config-dir resolution: CLAUDE_CONFIG_DIR overrides ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'token-usage-plugin');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');

// Installed hook lives under the plugin dir (ADR-012); LEGACY_HOOK_DEST is the pre-0.4.0
// location migrated away from.
const HOOK_DEST = path.join(PLUGIN_DIR, 'hook.js');
const LEGACY_HOOK_DEST = path.join(CLAUDE_DIR, 'hooks', 'token-usage-plugin.js');
// statusline.js is a pluginFiles entry and auto-updates the same way hook.js does.
const STATUSLINE_DEST = path.join(PLUGIN_DIR, 'statusline.js');

// Separate from the flush lock (queue/.lock): converge holds this across a slow network
// fetch and must not block a concurrent SessionEnd flush (ADR-012). Same stale-steal
// protocol as the flush lock (ADR-004).
const UPDATE_LOCK_FILE = path.join(PLUGIN_DIR, '.update.lock');

const TIMEOUT_MS = 5000;
const HOOK_FETCH_TIMEOUT_MS = 10000;

// --- Logging ---

function logError(context, err) {
  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- Atomic write ---

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// --- Config ---

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- HTTP ---

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Semver ---

function semverGt(a, b) {
  const parse = v => v.split('.').map(Number);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) {
    return a1 > b1;
  }
  if (a2 !== b2) {
    return a2 > b2;
  }
  return a3 > b3;
}

// --- Update lock ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireUpdateLock() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  // Two attempts: normal wx, then once more after unlinking a stale lock; wx is atomic,
  // so only one concurrent stealer ever wins the retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(UPDATE_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(UPDATE_LOCK_FILE, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      // A NaN/0 pid (crash between wx-create and pid-write) must be stealable, or an
      // empty lock blocks every future update forever.
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return false;
      }
      try {
        fs.rmSync(UPDATE_LOCK_FILE);
      } catch {}
    }
  }
  return false;
}

function releaseUpdateLock() {
  try {
    fs.rmSync(UPDATE_LOCK_FILE);
  } catch {}
}

// --- Settings ---

// $HOME-relative path when the target lives under the home directory on POSIX — hook
// commands run via `sh -c`, which expands $HOME, so one settings.json stays valid across
// a host and a devcontainer mounting ~/.claude at different paths (ADR-010). Falls back to
// the absolute path on Windows or a custom CLAUDE_CONFIG_DIR outside $HOME. Must yield the
// IDENTICAL string in every environment sharing the mount, or converge's drift check
// ping-pongs settings.json between them (ADR-012).
function resolveRef(dest) {
  const home = os.homedir();
  const rel = path.relative(home, dest);
  if (process.platform === 'win32' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return dest;
  }
  return `$HOME/${rel.split(path.sep).join('/')}`;
}

const HOOK_REF = resolveRef(HOOK_DEST);
const STATUSLINE_REF = resolveRef(STATUSLINE_DEST);

// Invoke Node via PATH rather than pinning process.execPath: a version-managed Node
// (nvm/mise/asdf) upgrade would break a pinned absolute path, a bare `node` survives it.
const CAPTURE_COMMAND = `node "${HOOK_REF}"`;
const FLUSH_COMMAND = `node "${HOOK_REF}" --flush`;
const CHECK_COMMAND = `node "${HOOK_REF}" --check-update`;
const SUBAGENT_COMMAND = `node "${HOOK_REF}" --subagent-stop`;
const STATUSLINE_COMMAND = `node "${STATUSLINE_REF}"`;

const HOOK_DEFS = [
  { event: 'Stop',         command: CAPTURE_COMMAND },
  { event: 'SessionEnd',   command: FLUSH_COMMAND },
  { event: 'SessionStart', command: CHECK_COMMAND },
  { event: 'SubagentStop', command: SUBAGENT_COMMAND },
];

// Matches both the current layout (`token-usage-plugin/hook.js`) and the legacy file
// (`hooks/token-usage-plugin.js`). Requiring a separator/dot right after the name excludes
// unrelated commands merely starting with it, e.g. `tokendashboard-plugin-exporter.js`
// (see ADR-010, ADR-012).
const HOOK_MATCH = /token-usage-plugin[/\\.]/;
const isOwnCommand = cmd => typeof cmd === 'string' && HOOK_MATCH.test(cmd);

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    // null (not {}) so converge never touches an unparseable user file; CLI callers surface it.
    return null;
  }
}

function writeSettings(settings) {
  atomicWriteSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function removeOwnHooks(hookList) {
  return hookList
    .map(entry => ({ ...entry, hooks: entry.hooks?.filter(h => !isOwnCommand(h.command)) ?? [] }))
    .filter(entry => entry.hooks.length > 0);
}

// Apply our hook entries idempotently: strip existing (ours/legacy) entries per event, then
// push the desired command. Foreign hooks and unrelated settings keys are preserved.
function patchSettings(settings) {
  settings.hooks ??= {};
  for (const { event, command } of HOOK_DEFS) {
    settings.hooks[event] = removeOwnHooks(settings.hooks[event] ?? []);
    settings.hooks[event].push({ hooks: [{ type: 'command', command }] });
  }
  return settings;
}

// Scoped, environment-stable drift check: are OUR entries already exactly correct? Never a
// full-file compare, so unrelated key reordering by other tools never reads as drift — this
// is what keeps converge's settings writes at zero in steady state (ADR-012).
function hooksAreCurrent(settings) {
  for (const { event, command } of HOOK_DEFS) {
    const entries = settings.hooks?.[event] ?? [];
    const ours = entries
      .flatMap(e => e.hooks ?? [])
      .map(h => h.command)
      .filter(isOwnCommand);
    if (ours.length !== 1 || ours[0] !== command) {
      return false;
    }
  }
  return true;
}

// statusLine is a single slot, not a list — a pre-existing foreign entry (matched by
// filename) is left untouched rather than clobbered.
const STATUSLINE_MATCH = path.basename(STATUSLINE_DEST);

function installStatusLine(settings) {
  const existing = settings.statusLine;
  if (existing?.command && !existing.command.includes(STATUSLINE_MATCH)) {
    console.log('Existing statusLine found — leaving it untouched. To use this plugin\'s statusline, add manually:');
    console.log(`  ${STATUSLINE_COMMAND}`);
    return;
  }
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
}

function uninstallStatusLine(settings) {
  if (settings.statusLine?.command?.includes(STATUSLINE_MATCH)) {
    delete settings.statusLine;
  }
}

// --- Install (npx, local) ---

// Durable files copied/fetched into the plugin dir, declared in package.json. updater.js
// is NOT a pluginFile — it's fetched fresh and never stored (ADR-012).
function localPluginFiles() {
  try {
    return require('./package.json').pluginFiles ?? ['hook.js'];
  } catch {
    return ['hook.js'];
  }
}

function install(version, apiBaseUrl, repoRawBaseUrl) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });

  // __dirname is only referenced here, never at module top level, so a stdin-run converge
  // (no meaningful __dirname, never calls install) is unaffected.
  for (const file of localPluginFiles()) {
    fs.copyFileSync(path.join(__dirname, file), path.join(PLUGIN_DIR, file));
  }
  console.log(`Hook installed: ${HOOK_DEST}`);

  // Redundant with the loop above (statusline.js is already a pluginFiles entry) but
  // harmless; kept for the distinct log line below.
  fs.copyFileSync(path.join(__dirname, 'statusline.js'), STATUSLINE_DEST);
  console.log(`Statusline installed: ${STATUSLINE_DEST}`);

  // No merge with a previously stored value — both flags are required on every
  // install/reinstall (enforced by main()'s check below), never silently reused (ADR-016).
  const existing = loadConfig();
  saveConfig({
    ...existing,
    currentVersion: version,
    lastUpdateCheck: new Date().toISOString(),
    apiBaseUrl,
    repoRawBaseUrl,
  });
  console.log(`API base URL: ${apiBaseUrl}`);
  console.log(`Update source: ${repoRawBaseUrl}`);

  // Files before settings: the payload exists before settings.json points at it, so a
  // concurrent session never reads a reference to a not-yet-present file (ADR-012).
  const settings = readSettings();
  if (settings === null) {
    console.error(`Error: Could not parse ${SETTINGS_PATH}`);
    process.exit(1);
  }
  patchSettings(settings);
  installStatusLine(settings);
  writeSettings(settings);
  console.log(`Settings updated: ${SETTINGS_PATH}`);
  console.log(`\nDone. Installed version ${version}.`);
}

// --- Uninstall ---

function uninstall() {
  // Refuse on an unparseable settings.json BEFORE deleting anything, or we'd remove the
  // hook files but leave dangling hook entries in place.
  const settings = readSettings();
  if (settings === null) {
    console.error(`Error: Could not parse ${SETTINGS_PATH}`);
    process.exit(1);
  }

  // Clear currentVersion first: it's the guard key an in-flight converge checks, so
  // removing it makes that converge abort instead of silently reverting this uninstall
  // (ADR-012).
  if (fs.existsSync(CONFIG_PATH)) {
    fs.rmSync(CONFIG_PATH);
  }

  for (const file of localPluginFiles()) {
    const p = path.join(PLUGIN_DIR, file);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
    }
  }
  // Only ever removed here — converge never deletes it (a parallel pre-migration session
  // may still be bound to it; see ADR-012).
  if (fs.existsSync(LEGACY_HOOK_DEST)) {
    fs.rmSync(LEGACY_HOOK_DEST);
  }
  console.log(`Hook removed: ${HOOK_DEST}`);

  if (fs.existsSync(STATUSLINE_DEST)) {
    fs.rmSync(STATUSLINE_DEST);
    console.log(`Statusline removed: ${STATUSLINE_DEST}`);
  }

  uninstallStatusLine(settings);

  if (!settings.hooks) {
    writeSettings(settings);
    console.log(`Settings updated: ${SETTINGS_PATH}`);
    console.log('\nDone. Token usage tracking removed.');
    return;
  }
  for (const { event } of HOOK_DEFS) {
    if (!settings.hooks[event]) {
      continue;
    }
    settings.hooks[event] = removeOwnHooks(settings.hooks[event]);
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  writeSettings(settings);
  console.log(`Settings updated: ${SETTINGS_PATH}`);
  console.log('\nDone. Token usage tracking removed.');
}

// --- Converge (fetched-run, from hook.js loader via stdin) ---

// Strip a trailing slash so a configured base URL ending in `/` doesn't produce a
// double-slash path.
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

// Fetch and reconcile the installation to the desired state. Idempotent: with correct
// files and settings already in place it performs no writes (steady state).
async function converge() {
  const config = loadConfig();
  if (!config.currentVersion) {
    return; // Not installed — nothing to converge.
  }
  if (!acquireUpdateLock()) {
    return; // Another session is already updating (thundering-herd guard — ADR-012).
  }
  try {
    const rawBase = config.repoRawBaseUrl;
    if (!rawBase) {
      return; // No update source configured — never touch anything (see ADR-016).
    }
    const pkgRes = await fetchWithTimeout(rawUrl(rawBase, 'package.json'));
    if (!pkgRes?.ok) {
      return;
    }
    let remote;
    try {
      remote = await pkgRes.json();
    } catch {
      return;
    }
    const remoteVersion = remote.version;
    if (!remoteVersion) {
      return;
    }
    const pluginFiles = Array.isArray(remote.pluginFiles) && remote.pluginFiles.length
      ? remote.pluginFiles
      : ['hook.js'];

    // Re-read after the network round-trip: a concurrent uninstall may have cleared
    // currentVersion while we fetched — abort rather than reviving a removed install (ADR-012).
    const current = loadConfig().currentVersion;
    if (!current) {
      return;
    }

    // Fetch when the remote is newer, OR a payload file is missing AND the remote is not
    // OLDER. The missing-file branch drives migration (a version-only check would see
    // "equal" post-migration and never relocate); excluding an older remote preserves the
    // no-downgrade guarantee (ADR-007, ADR-012).
    const filePath = f => path.join(PLUGIN_DIR, f);
    const filesMissing = pluginFiles.some(f => !fs.existsSync(filePath(f)));
    if (semverGt(remoteVersion, current) || (filesMissing && !semverGt(current, remoteVersion))) {
      await downloadPluginFiles(pluginFiles, remoteVersion, rawBase);
    }

    // Re-read once more: downloadPluginFiles may have bumped currentVersion, or a
    // concurrent uninstall may have cleared it (ADR-012).
    const freshConfig = loadConfig();

    // Repoint settings only on drift, and only once every payload file is actually on disk
    // (files-before-settings invariant) — otherwise a failed download could repoint settings
    // at a file that doesn't exist yet (ADR-012).
    const filesReady = pluginFiles.every(f => fs.existsSync(filePath(f)));
    const settings = readSettings();
    if (filesReady && settings && !hooksAreCurrent(settings) && freshConfig.currentVersion) {
      writeSettings(patchSettings(settings));
    }

    // "Blocked by an older remote": a payload file is still missing AND the remote is
    // strictly older, so the no-downgrade guard above correctly declined the download —
    // not a fetch failure. Recording this lets the loader fall back to the 24h throttle
    // instead of retrying every session; cleared once the remote is no longer older (ADR-012).
    const migrationBlockedByOlderRemote = filesMissing && semverGt(current, remoteVersion);

    // Stamp lastUpdateCheck only once a terminal state is reached (fully converged, or
    // migration correctly declined) — stamping right after the probe would throttle for
    // 24h after a merely-transient download failure.
    const fullyConverged = filesReady && freshConfig.currentVersion
      && !semverGt(remoteVersion, freshConfig.currentVersion);
    if (freshConfig.currentVersion && (fullyConverged || migrationBlockedByOlderRemote)) {
      saveConfig({
        ...freshConfig,
        lastUpdateCheck: new Date().toISOString(),
        migrationBlocked: migrationBlockedByOlderRemote,
      });
    }
  } catch (err) {
    logError('converge', err);
  } finally {
    releaseUpdateLock();
  }
}

// A 200 response is not proof the body is our source (a proxy/CDN/SSO gate can return a
// login page with 200) — writing that as hook.js would permanently wedge telemetry. For a
// .js payload, compile it without executing so only parseable JavaScript is published
// (ADR-012). Non-.js payloads keep only the cheap doctype guard.
function isValidPayload(file, content) {
  if (content.trimStart().startsWith('<!')) {
    return false; // HTML error page, not source
  }
  if (file.endsWith('.js')) {
    try {
      // Strip a leading shebang before compiling (hook.js has one).
      new vm.Script(content.replace(/^#![^\n]*\n/, ''), { filename: file });
    } catch {
      return false; // not parseable JS — a junk body served with HTTP 200
    }
  }
  return true;
}

// Download every payload file, then publish them. Per-file atomic (tmp + rename); the set
// is NOT atomic as a whole (POSIX has no multi-file rename) — the update lock serializes
// converge once a second pluginFile exists (ADR-012). currentVersion bumps only after
// every file lands, so a partial fetch is retried next session.
async function downloadPluginFiles(pluginFiles, remoteVersion, rawBase) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const staged = [];
  for (const file of pluginFiles) {
    const res = await fetchWithTimeout(rawUrl(rawBase, file), {}, HOOK_FETCH_TIMEOUT_MS);
    if (!res?.ok) {
      cleanupTmp(staged);
      return;
    }
    let content;
    try {
      content = await res.text();
    } catch {
      cleanupTmp(staged);
      return;
    }
    if (!isValidPayload(file, content)) {
      cleanupTmp(staged); // not our source — HTML/login page or JSON error body served with 200
      return;
    }
    const tmp = `${path.join(PLUGIN_DIR, file)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    staged.push({ tmp, dest: path.join(PLUGIN_DIR, file) });
  }
  try {
    // A concurrent uninstall may have cleared currentVersion while we fetched — abort
    // rather than re-materializing a removed install (ADR-012).
    if (!loadConfig().currentVersion) {
      cleanupTmp(staged);
      return;
    }
    for (const { tmp, dest } of staged) {
      fs.renameSync(tmp, dest); // atomic per file — a reader sees old or new, never partial
    }
    saveConfig({ ...loadConfig(), currentVersion: remoteVersion });
  } catch (err) {
    // A write/rename failure must not leave staged .tmp files behind.
    cleanupTmp(staged);
    throw err;
  }
}

function cleanupTmp(staged) {
  for (const { tmp } of staged) {
    try {
      fs.rmSync(tmp);
    } catch {}
  }
}

// --- Entry ---

function run(command, version, apiBaseUrl, repoRawBaseUrl) {
  if (command === 'install') {
    install(version, apiBaseUrl, repoRawBaseUrl);
  } else if (command === 'uninstall') {
    uninstall();
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: tokendashboard-plugin-claude install --api-base-url <url> --repo-raw-base-url <url> | uninstall');
    process.exit(1);
  }
}

// Pulls `--api-base-url <url>` or `=<url>` out of the raw CLI args. No hardcoded default —
// every deployment points at its own API host (ADR-016). hook.js appends fixed route
// suffixes to this base.
function parseApiBaseUrlArg(args) {
  const eq = args.find(a => a.startsWith('--api-base-url='));
  if (eq) {
    return eq.slice('--api-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--api-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// Pulls `--repo-raw-base-url <url>` or `=<url>` out of the raw CLI args. No default,
// required on every install like --api-base-url (ADR-016).
function parseRepoUrlArg(args) {
  const eq = args.find(a => a.startsWith('--repo-raw-base-url='));
  if (eq) {
    return eq.slice('--repo-raw-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--repo-raw-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// Flags taking a separate-token value. Command extraction must skip that value token too,
// or omitting `install`/`uninstall` would misparse the URL itself as the command.
const VALUE_FLAGS = ['--api-base-url', '--repo-raw-base-url'];

// Rejects malformed http(s) URLs so a typo fails fast at install time. `requirePath` is
// false for --api-base-url (hook.js appends fixed route suffixes, so a bare origin is
// valid) but true for --repo-raw-base-url, which points at one specific path (ADR-016).
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isPlausibleUrl(value, { requirePath = true } = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      // ok
    } else if (parsed.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(parsed.hostname)) {
      // ok — local development only
    } else {
      return false;
    }
    return !requirePath || parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

// The first token that isn't a `--flag` and isn't a value belonging to one, or undefined
// if every token is a flag/its value.
function extractCommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.includes(a)) {
        i++; // skip this flag's separate-token value
      }
      continue;
    }
    return a;
  }
  return undefined;
}

async function main() {
  // Fetched-run path: hook.js's loader spawns `node -` and passes the mode via env.
  if (process.env.TUP_MODE === 'converge') {
    await converge();
    return;
  }
  // Direct CLI invocation (`node updater.js install --api-base-url <url>|uninstall`).
  const args = process.argv.slice(2);
  const command = extractCommand(args) ?? 'install';
  let version, apiBaseUrl, repoRawBaseUrl;
  if (command === 'install') {
    // A missing/corrupt package.json must fail loudly rather than installing with
    // version: undefined — checkUpdate/converge both gate on a truthy currentVersion.
    let pkg;
    try {
      pkg = require('./package.json');
    } catch (err) {
      console.error(`Cannot read package.json: ${err.message}`);
      process.exit(1);
    }
    version = pkg.version;
    if (!version) {
      console.error('package.json has no version field — cannot install');
      process.exit(1);
    }
    apiBaseUrl = parseApiBaseUrlArg(args);
    repoRawBaseUrl = parseRepoUrlArg(args);
    // Both required on EVERY install/reinstall, never read back from config.json (ADR-016).
    if (!apiBaseUrl || !repoRawBaseUrl) {
      console.error(
        'Missing required --api-base-url <url> and/or --repo-raw-base-url <url>.'
      );
      console.error(
        'Usage: npx <package> install --api-base-url <url> --repo-raw-base-url <url>'
      );
      process.exit(1);
    }
    if (!isPlausibleUrl(apiBaseUrl, { requirePath: false }) || !isPlausibleUrl(repoRawBaseUrl)) {
      console.error('--api-base-url and --repo-raw-base-url must be valid http(s) URLs.');
      process.exit(1);
    }
  }
  run(command, version, apiBaseUrl, repoRawBaseUrl);
}

// Runs when executed directly, or from the loader's stdin run — a stdin program (`node -`)
// has no main module, so it's recognized by that absent main plus TUP_MODE. Requiring the
// absent main (not just TUP_MODE) keeps a stray ambient TUP_MODE from turning a plain
// `require('./updater.js')` (e.g. from a test) into an unintended lifecycle action.
if (require.main === module || (!require.main && process.env.TUP_MODE === 'converge')) {
  main().catch(err => {
    logError('main', err);
    process.exit(0);
  });
}

module.exports = {
  atomicWriteSync,
  loadConfig,
  saveConfig,
  semverGt,
  isProcessAlive,
  acquireUpdateLock,
  releaseUpdateLock,
  hooksAreCurrent,
  isValidPayload,
  install,
  uninstall,
  converge,
  run,
  parseApiBaseUrlArg,
  parseRepoUrlArg,
  extractCommand,
  isPlausibleUrl,
  HOOK_DEST,
  LEGACY_HOOK_DEST,
  STATUSLINE_DEST,
  HOOK_MATCH,
};
