#!/usr/bin/env node

'use strict';

// Standalone report CLI for the local usage storage.
// Invoked directly — `node ~/.claude/tokendashboard-plugin/report.js --weekly` (or
// `--monthly`, see PERIODS below) — not through any hook event, so it does not
// require() hook.js/updater.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(CLAUDE_DIR, 'tokendashboard-plugin');
const LOCAL_STORAGE_DB_PATH = path.join(PLUGIN_DIR, 'local.sqlite');
// Sibling of queue/ (not inside it — reports are a CLI output, not a telemetry payload).
const REPORTS_DIR = path.join(PLUGIN_DIR, 'reports');

// Opens local.sqlite read-only. Returns null (not a throw) when the file does not exist
// yet (no capture has ever run) — the caller renders that as "no data", not a crash.
function openReadOnly(dbPath = LOCAL_STORAGE_DB_PATH) {
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
    COALESCE(git_project, '(none)') AS git_project,
    COALESCE(branch, '(none)') AS branch,
    COALESCE(type, '(none)') AS type,
    COUNT(*) AS entries,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_write_tokens + ephemeral_5m_tokens + ephemeral_1h_tokens) AS cache_write_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(price_cents) AS price_cents
  FROM usage_entries
  GROUP BY period, project, git_project, branch, type
  ORDER BY period, project, git_project, branch, type
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

// --- `--git_project`/`--project` modes: lifetime totals, NOT bucketed by calendar period
// — answer "what did this cost", not "what happened in week Y". Both produce the same
// three sections (identity alone, identity+branch, identity+model+type) but differ in
// which column is "identity": `git_project` (the enclosing repo dir — dedupes same-named
// checkouts) or `project` (the base-worktree folder name). Picking one over the other is
// too situational to bake in as a single default (see CLAUDE.md) — two flags, not one
// report with a hardcoded grouping.
const LIFETIME_REPORTS = {
  '--git_project': { identityCol: 'git_project', label: 'Git Project' },
  '--project': { identityCol: 'project', label: 'Project' },
};

// The three fixed sections for one identity column. Exported separately from
// LIFETIME_REPORTS so a test (or a future third identity column) can build the section
// list directly.
function branchSectionsFor(identityCol) {
  return [
    { title: `By ${identityCol}`, groupCols: [identityCol] },
    { title: 'By Branch', groupCols: [identityCol, 'branch'] },
    { title: 'By Model & Type', groupCols: [identityCol, 'model', 'type'] },
  ];
}

// Builds a GROUP BY query for one fixed set of dimension columns (from BRANCH_REPORTS —
// never user input, so string-joining the column names into the query text is safe).
// Rows with a NULL `branch` sort last regardless of entry count — untagged/uncategorized
// work shouldn't outrank a real branch just because it happens to have more turns.
function buildGroupedQuery(groupCols) {
  const dimensionCols = groupCols.map(c => `COALESCE(${c}, '(none)') AS ${c}`).join(',\n    ');
  const orderPrefix = groupCols.includes('branch') ? 'branch IS NULL, ' : '';
  return `
    SELECT
      ${dimensionCols},
      COUNT(*) AS entries,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_write_tokens + ephemeral_5m_tokens + ephemeral_1h_tokens) AS cache_write_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(price_cents) AS price_cents
    FROM usage_entries
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY ${groupCols.join(', ')}
    ORDER BY ${orderPrefix}entries DESC
  `;
}

// Runs one grouped aggregation against an already-open DatabaseSync, bounded to
// [from, to] (full ISO timestamps, inclusive). Exported separately so tests can seed
// fixture rows and assert on the returned rows directly.
function groupedReport(db, groupCols, from, to) {
  return db.prepare(buildGroupedQuery(groupCols)).all(from, to);
}

// Column set for one BRANCH_REPORTS section: its own dimension columns first (in the
// order given), then the same fixed aggregate columns every section shares.
function columnsFor(groupCols) {
  return [
    ...groupCols.map(c => ({ header: c, value: row => row[c] })),
    { header: 'entries', value: row => row.entries },
    { header: 'in', value: row => row.input_tokens },
    { header: 'out', value: row => row.output_tokens },
    { header: 'cache_write', value: row => row.cache_write_tokens },
    { header: 'cache_read', value: row => row.cache_read_tokens },
    { header: 'price', value: row => formatCents(row.price_cents) },
  ];
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
  { header: 'git_project', value: row => row.git_project },
  { header: 'branch', value: row => row.branch },
  { header: 'type', value: row => row.type },
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

// `null` (not a string) when there is no data, same contract as formatReportMarkdown —
// all three sections query the same table over the same [from, to], so they are either
// all empty (no entries in range) or all non-empty; never a mix. `reportsData` is
// branchSectionsFor(identityCol) enriched with each section's own `rows` (see main()) —
// one `##` heading + table per section, in that order. `label` names the identity column
// for the top heading (see LIFETIME_REPORTS), same role as formatReportMarkdown's period
// label.
function formatBranchReportMarkdown(reportsData, from, to, label) {
  if (reportsData.every(r => r.rows.length === 0)) {
    return null;
  }
  const lines = [
    `# ${label} Token Usage Report`, '',
    `Range: ${from.slice(0, 10)} – ${to.slice(0, 10)}`, '',
  ];
  for (const { title, groupCols, rows } of reportsData) {
    const columns = columnsFor(groupCols);
    const headerLine = `| ${columns.map(c => c.header).join(' | ')} |`;
    const separatorLine = `|${columns.map(() => '---').join('|')}|`;
    lines.push(`## ${title}`, '', headerLine, separatorLine);
    for (const row of rows) {
      lines.push(`| ${columns.map(c => c.value(row)).join(' | ')} |`);
    }
    lines.push('');
  }
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

const REPORT_FLAGS = [...Object.keys(PERIODS), ...Object.keys(LIFETIME_REPORTS)];
const USAGE = `Usage: report.js <${REPORT_FLAGS.join('|')}> [--from YYYY-MM-DD] [--to YYYY-MM-DD]`;

const DATE_ARG_RE = /^\d{4}-\d{2}-\d{2}$/;

// Reads `--from`/`--to <YYYY-MM-DD>` out of argv (LIFETIME_REPORTS modes only — see main()).
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

  // --from/--to only apply to the LIFETIME_REPORTS modes (the period modes have no notion
  // of a bound range yet) — validated up front, before opening the DB, so a bad flag never
  // leaves a dangling open handle.
  let range = null;
  if (flag in LIFETIME_REPORTS) {
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
    if (flag in LIFETIME_REPORTS) {
      const { identityCol, label } = LIFETIME_REPORTS[flag];
      const reportsData = branchSectionsFor(identityCol).map(({ title, groupCols }) => ({
        title,
        groupCols,
        rows: groupedReport(db, groupCols, range.from, range.to),
      }));
      markdown = formatBranchReportMarkdown(reportsData, range.from, range.to, label);
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
  LOCAL_STORAGE_DB_PATH,
  REPORTS_DIR,
  PERIODS,
  LIFETIME_REPORTS,
  branchSectionsFor,
  REPORT_COLUMNS,
  columnsFor,
  openReadOnly,
  periodReport,
  groupedReport,
  defaultReportRange,
  parseDateFlag,
  formatReportMarkdown,
  formatBranchReportMarkdown,
  formatCents,
  reportFileName,
  writeReport,
  main,
};
