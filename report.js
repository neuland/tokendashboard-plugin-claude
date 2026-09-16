#!/usr/bin/env node

'use strict';

// Standalone report CLI for the local usage history.
// Invoked directly — `node ~/.claude/tokendashboard-plugin/report.js --weekly` (or
// `--monthly`, see PERIODS below) — not through any hook event, so it does not
// require() hook.js/updater.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'tokendashboard-plugin');
const LOCAL_HISTORY_DB_PATH = path.join(PLUGIN_DIR, 'local.sqlite');
// Sibling of queue/ (not inside it — reports are a CLI output, not a telemetry payload).
const REPORTS_DIR = path.join(PLUGIN_DIR, 'reports');

// Opens local.sqlite read-only. Returns null (not a throw) when the file does not exist
// yet (no capture has ever run) — the caller renders that as "no data", not a crash.
function openReadOnly(dbPath = LOCAL_HISTORY_DB_PATH) {
  const { DatabaseSync } = require('node:sqlite');
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// The period bucket is computed by SQLite's own strftime, bound as a query parameter
// (not string-interpolated) so the query text is identical across periods — only the
// format string differs. `%Y-W%W` (week of year) is not a true ISO-8601 week, and
// `%Y-%m` is a plain calendar month; both are good enough for human-readable grouping.
const PERIOD_REPORT_QUERY = `
  SELECT
    strftime(?, timestamp) AS period,
    COALESCE(project, '(none)') AS project,
    COALESCE(branch, '(none)') AS branch,
    COUNT(*) AS entries,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(cache_read_tokens + ephemeral_5m_tokens + ephemeral_1h_tokens) AS cache_read_tokens,
    SUM(price_cents) AS price_cents
  FROM usage_entries
  GROUP BY period, project, branch
  ORDER BY period, project, branch
`;

// One entry per supported CLI flag — the only thing that differs between report periods
// is the strftime format and a human label for the Markdown heading. Adding a new period
// (e.g. `--daily`) only ever means adding an entry here.
const PERIODS = {
  '--weekly': { strftimeFmt: '%Y-W%W', label: 'Weekly' },
  '--monthly': { strftimeFmt: '%Y-%m', label: 'Monthly' },
};

// Runs the aggregation for one period (see PERIODS) against an already-open
// DatabaseSync. Exported separately from the CLI so tests can seed fixture rows and
// assert on the returned rows directly.
function periodReport(db, strftimeFmt) {
  return db.prepare(PERIOD_REPORT_QUERY).all(strftimeFmt);
}

// --- `--branches` mode: lifetime totals grouped by project/branch, NOT bucketed by
// calendar period — answers "what did this branch cost", not "what happened in week Y"
const BRANCH_REPORT_GROUP_COLS = ['project', 'branch'];

const BRANCH_REPORT_QUERY = `
  SELECT
    COALESCE(project, '(none)') AS project,
    COALESCE(branch, '(none)') AS branch,
    COUNT(*) AS entries,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(cache_read_tokens + ephemeral_5m_tokens + ephemeral_1h_tokens) AS cache_read_tokens,
    SUM(price_cents) AS price_cents
  FROM usage_entries
  WHERE timestamp >= ? AND timestamp <= ?
  GROUP BY project, branch
  ORDER BY branch IS NULL, entries DESC
`;

// Runs the --branches aggregation against an already-open DatabaseSync, bounded to
// [from, to] (full ISO timestamps, inclusive). Exported separately so tests can seed
// fixture rows and assert on the returned rows directly. Rows with a NULL branch sort
// last, regardless of entry count — untagged/uncategorized work shouldn't outrank a real
// branch just because it happens to have more turns.
function branchReport(db, from, to) {
  return db.prepare(BRANCH_REPORT_QUERY).all(from, to);
}

// Default window when neither --from nor --to is given: the trailing month up to now —
// without a default, a long-lived branch would permanently dominate every report.
function defaultReportRange(now = new Date()) {
  const to = now;
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(4)}`;
}

// Single source of truth for both the header row and each data row — header and cells
// can no longer drift out of sync.
const REPORT_COLUMNS = [
  { header: 'project', value: row => row.project },
  { header: 'branch', value: row => row.branch },
  { header: 'entries', value: row => row.entries },
  { header: 'in', value: row => row.input_tokens },
  { header: 'out', value: row => row.output_tokens },
  { header: 'cache_write', value: row => row.cache_write_tokens },
  { header: 'cache_read', value: row => row.cache_read_tokens },
  { header: 'price', value: row => formatCents(row.price_cents) },
];

// Markdown report: one `##` heading + table per period bucket. `null` (not a string)
// when there is no data, so the caller can decide not to write an empty file rather than
// checking a magic string.
function formatReportMarkdown(rows, label) {
  if (rows.length === 0) {
    return null;
  }
  const headerLine = `| ${REPORT_COLUMNS.map(c => c.header).join(' | ')} |`;
  const separatorLine = `|${REPORT_COLUMNS.map(() => '---').join('|')}|`;
  const lines = [`# ${label} Token Usage Report`, ''];
  let currentPeriod = null;
  for (const row of rows) {
    if (row.period !== currentPeriod) {
      currentPeriod = row.period;
      lines.push(`## ${currentPeriod}`, '', headerLine, separatorLine);
    }
    lines.push(`| ${REPORT_COLUMNS.map(c => c.value(row)).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const BRANCH_REPORT_COLUMNS = [
  { header: 'project', value: row => row.project },
  { header: 'branch', value: row => row.branch },
  { header: 'entries', value: row => row.entries },
  { header: 'in', value: row => row.input_tokens },
  { header: 'out', value: row => row.output_tokens },
  { header: 'cache_write', value: row => row.cache_write_tokens },
  { header: 'cache_read', value: row => row.cache_read_tokens },
  { header: 'price', value: row => formatCents(row.price_cents) },
];

// `null` (not a string) when there is no data, same contract as formatReportMarkdown —
// a single table (lifetime totals in [from, to]), not bucketed by calendar period.
function formatBranchReportMarkdown(rows, from, to) {
  if (rows.length === 0) {
    return null;
  }
  const headerLine = `| ${BRANCH_REPORT_COLUMNS.map(c => c.header).join(' | ')} |`;
  const separatorLine = `|${BRANCH_REPORT_COLUMNS.map(() => '---').join('|')}|`;
  const lines = [
    '# Branches Token Usage Report', '',
    `Range: ${from.slice(0, 10)} – ${to.slice(0, 10)}`, '',
    headerLine, separatorLine,
  ];
  for (const row of rows) {
    lines.push(`| ${BRANCH_REPORT_COLUMNS.map(c => c.value(row)).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ISO timestamp with `:`/`.` replaced (invalid in Windows filenames), plus pid so two
// runs started in the same second never collide — same spirit as the queue's
// `[timestamp]-[pid].json` naming (see CLAUDE.md), reports just sit in their own
// sibling dir instead of queue/.
function reportFileName(now = new Date()) {
  return `report-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}.md`;
}

function writeReport(markdown, now = new Date()) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, reportFileName(now));
  fs.writeFileSync(filePath, markdown);
  return filePath;
}

const REPORT_FLAGS = [...Object.keys(PERIODS), '--branches'];
const USAGE = `Usage: report.js <${REPORT_FLAGS.join('|')}> [--from YYYY-MM-DD] [--to YYYY-MM-DD]`;

const DATE_ARG_RE = /^\d{4}-\d{2}-\d{2}$/;

// Reads `--from`/`--to <YYYY-MM-DD>` out of argv (--branches only — see main()).
// { present: false } when the flag is absent; { present: true, error: true } when given
// without a validly-formatted value; otherwise { present: true, value }.
function parseDateFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) {
    return { present: false };
  }
  const value = argv[idx + 1];
  if (!value || !DATE_ARG_RE.test(value)) {
    return { present: true, error: true };
  }
  return { present: true, value };
}

function main(argv = process.argv.slice(2)) {
  const matchedFlags = argv.filter(a => REPORT_FLAGS.includes(a));
  if (matchedFlags.length !== 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const flag = matchedFlags[0];

  // --from/--to only apply to --branches (the period modes have no notion of a bound
  // range yet) — validated up front, before opening the DB, so a bad flag never leaves a
  // dangling open handle.
  let range = null;
  if (flag === '--branches') {
    const fromArg = parseDateFlag(argv, '--from');
    const toArg = parseDateFlag(argv, '--to');
    if (fromArg.error || toArg.error) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    const defaults = defaultReportRange();
    range = {
      from: fromArg.value ? `${fromArg.value}T00:00:00.000Z` : defaults.from,
      to: toArg.value ? `${toArg.value}T23:59:59.999Z` : defaults.to,
    };
  }

  const db = openReadOnly();
  if (!db) {
    console.log('No data yet — local.sqlite does not exist.');
    return;
  }
  let markdown;
  try {
    if (flag === '--branches') {
      markdown = formatBranchReportMarkdown(branchReport(db, range.from, range.to), range.from, range.to);
    } else {
      const { strftimeFmt, label } = PERIODS[flag];
      markdown = formatReportMarkdown(periodReport(db, strftimeFmt), label);
    }
  } finally {
    db.close();
  }
  if (!markdown) {
    console.log('No data yet — local.sqlite has no entries.');
    return;
  }
  const filePath = writeReport(markdown);
  console.log(`Report written to: ${filePath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  LOCAL_HISTORY_DB_PATH,
  REPORTS_DIR,
  PERIODS,
  BRANCH_REPORT_GROUP_COLS,
  REPORT_COLUMNS,
  BRANCH_REPORT_COLUMNS,
  openReadOnly,
  periodReport,
  branchReport,
  defaultReportRange,
  parseDateFlag,
  formatReportMarkdown,
  formatBranchReportMarkdown,
  formatCents,
  reportFileName,
  writeReport,
  main,
};
