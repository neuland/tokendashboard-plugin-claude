'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { inReportSandbox } = require('./helpers.js');

const sampleEntry = (overrides = {}) => ({
  entry_id: overrides.entry_id ?? 'e1',
  session_id: 's1',
  timestamp: '2026-09-11T10:00:00.000Z',
  model: 'claude-opus-4-8',
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    ephemeral_5m_input_tokens: 2,
    ephemeral_1h_input_tokens: 1,
  },
  price_cents: 5.5,
  ...overrides,
});

test('branchReport groups by project and branch', () => {
  inReportSandbox((report, hook) => {
    // given
    hook.writeLocalHistory(sampleEntry({
      entry_id: 'e1', project: 'backend', branch: 'send-data',
    }));
    hook.writeLocalHistory(sampleEntry({
      entry_id: 'e2', project: 'backend', branch: 'send-data',
    }));
    hook.writeLocalHistory(sampleEntry({
      entry_id: 'e3', project: 'frontend', branch: 'send-data',
    }));
    hook.writeLocalHistory(sampleEntry({
      entry_id: 'e4', project: 'backend', branch: 'receive-answer',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.branchReport(db, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');
    } finally {
      db.close();
    }

    assert.equal(rows.length, 3); // different branch and project -> separate rows
    const byProjectBranch = Object.fromEntries(rows.map(r => [`${r.project}/${r.branch}`, r.entries]));
    assert.deepEqual(byProjectBranch, {
      'backend/send-data': 2,
      'frontend/send-data': 1,
      'backend/receive-answer': 1,
    });
  });
});

test('branchReport only counts entries inside [from, to]', () => {
  inReportSandbox((report, hook) => {
    // given
    hook.writeLocalHistory(sampleEntry({ entry_id: 'in-range', timestamp: '2026-06-15T00:00:00.000Z' }));
    hook.writeLocalHistory(sampleEntry({ entry_id: 'too-early', timestamp: '2026-01-01T00:00:00.000Z' }));
    hook.writeLocalHistory(sampleEntry({ entry_id: 'too-late', timestamp: '2026-12-31T00:00:00.000Z' }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.branchReport(db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    } finally {
      db.close();
    }

    // then
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entries, 1);
  });
});

test('branchReport sorts NULL-branch rows last, regardless of entry count', () => {
  inReportSandbox((report, hook) => {
    // given — an untagged bucket with MORE entries than the tagged one
    for (let i = 0; i < 5; i++) {
      hook.writeLocalHistory(sampleEntry({ entry_id: `untagged-${i}` })); // no project/branch
    }
    hook.writeLocalHistory(sampleEntry({
      entry_id: 'tagged', project: 'backend', branch: 'send-data',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.branchReport(db, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');
    } finally {
      db.close();
    }

    // then — tagged row (1 entry) still sorts before the untagged row (5 entries)
    assert.equal(rows.length, 2);
    assert.equal(rows[0].branch, 'send-data');
    assert.equal(rows[0].entries, 1);
    assert.equal(rows[1].branch, '(none)');
    assert.equal(rows[1].entries, 5);
  });
});

test('branchReport sorts non-null-branch rows by entries descending', () => {
  inReportSandbox((report, hook) => {
    // given
    hook.writeLocalHistory(sampleEntry({ entry_id: 'e1', branch: 'small' }));
    for (let i = 0; i < 3; i++) {
      hook.writeLocalHistory(sampleEntry({ entry_id: `e-big-${i}`, branch: 'big' }));
    }

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.branchReport(db, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');
    } finally {
      db.close();
    }

    // then
    assert.deepEqual(rows.map(r => r.branch), ['big', 'small']);
  });
});

test('defaultReportRange spans the trailing month up to "now"', () => {
  inReportSandbox(report => {
    // given
    const now = new Date('2026-09-15T12:00:00.000Z');

    // when
    const { from, to } = report.defaultReportRange(now);

    // then
    assert.equal(to, '2026-09-15T12:00:00.000Z');
    assert.equal(from, '2026-08-15T12:00:00.000Z');
  });
});

test('parseDateFlag: absent, valid, and invalid --from/--to', () => {
  inReportSandbox(report => {
    // given / when / then
    assert.deepEqual(report.parseDateFlag(['--branches'], '--from'), { present: false });
    assert.deepEqual(report.parseDateFlag(['--branches', '--from', '2026-08-01'], '--from'), { present: true, value: '2026-08-01' });
    assert.deepEqual(report.parseDateFlag(['--branches', '--from', 'not-a-date'], '--from'), { present: true, error: true });
    assert.deepEqual(report.parseDateFlag(['--branches', '--from'], '--from'), { present: true, error: true }); // missing value
  });
});

test('formatBranchReportMarkdown returns null when there is no data', () => {
  inReportSandbox(report => {
    // given / when / then
    assert.equal(report.formatBranchReportMarkdown([], '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'), null);
  });
});

test('formatBranchReportMarkdown renders one table, the date range, and the branch rows', () => {
  inReportSandbox((report, hook) => {
    // given
    hook.writeLocalHistory(sampleEntry({ project: 'backend', branch: 'send-data' }));

    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.branchReport(db, '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');
    } finally {
      db.close();
    }

    // when
    const md = report.formatBranchReportMarkdown(rows, '2026-08-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');

    // then
    assert.ok(md.startsWith('# Branches Token Usage Report'));
    assert.ok(md.includes('Range: 2026-08-11 – 2026-09-11'));
    assert.ok(md.includes('| project | branch | type | entries |'));
    assert.ok(md.includes('backend'));
    assert.ok(md.includes('send-data'));
  });
});

test('main() --branches with no data in the default (trailing-month) range writes no file', () => {
  inReportSandbox((report, hook) => {
    // given — an entry far outside the default trailing-month window
    hook.writeLocalHistory(sampleEntry({ timestamp: '2020-01-01T00:00:00.000Z' }));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--branches']);

      // then
      assert.ok(logs.some(l => l.includes('local.sqlite has no entries')));
      assert.ok(!fs.existsSync(report.REPORTS_DIR));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() --branches --from --to uses the explicit range instead of the default', () => {
  inReportSandbox((report, hook) => {
    // given — well outside the default trailing-month window, but inside --from/--to
    hook.writeLocalHistory(sampleEntry({ project: 'backend', branch: 'send-data', timestamp: '2020-05-15T00:00:00.000Z' }));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--branches', '--from', '2020-05-01', '--to', '2020-05-31']);

      // then
      const match = logs[0]?.match(/^Report written to: (.+)$/);
      assert.ok(match, `expected a written-report log line, got: ${JSON.stringify(logs)}`);
      const content = fs.readFileSync(match[1], 'utf8');
      assert.ok(content.includes('Range: 2020-05-01 – 2020-05-31'));
      assert.ok(content.includes('send-data'));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() --branches with a malformed --from prints usage and exits 1, without writing local.sqlite', () => {
  inReportSandbox((report, hook) => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main(['--branches', '--from', 'not-a-date']);

      // then
      assert.equal(process.exitCode, 1);
      assert.ok(errors.some(l => l.includes('--branches')));
      assert.ok(!fs.existsSync(hook.LOCAL_HISTORY_DB_PATH));
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});

test('main() usage message lists --branches alongside --weekly/--monthly', () => {
  inReportSandbox(report => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main([]);

      // then
      assert.ok(errors.some(l => l.includes('--weekly') && l.includes('--monthly') && l.includes('--branches')));
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});
