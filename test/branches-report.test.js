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

const FULL_RANGE = ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'];

test('LIFETIME_REPORTS defines the --git_project and --project modes, each with its own identity column and label', () => {
  inReportSandbox(report => {
    // given / when / then — pins the contract so a future edit is a deliberate, visible
    // test change, not a silent drift
    assert.deepEqual(report.LIFETIME_REPORTS, {
      '--git_project': { identityCol: 'git_project', label: 'Git Project' },
      '--project': { identityCol: 'project', label: 'Project' },
    });
  });
});

test('branchSectionsFor builds the three fixed sections for a given identity column, in order', () => {
  inReportSandbox(report => {
    // given / when / then
    assert.deepEqual(report.branchSectionsFor('git_project'), [
      { title: 'By git_project', groupCols: ['git_project'] },
      { title: 'By Branch', groupCols: ['git_project', 'branch'] },
      { title: 'By Model & Type', groupCols: ['git_project', 'model', 'type'] },
    ]);
    assert.deepEqual(report.branchSectionsFor('project'), [
      { title: 'By project', groupCols: ['project'] },
      { title: 'By Branch', groupCols: ['project', 'branch'] },
      { title: 'By Model & Type', groupCols: ['project', 'model', 'type'] },
    ]);
  });
});

test('groupedReport groups by git_project alone, disambiguating same-named projects', () => {
  inReportSandbox((report, localStorage) => {
    // given — two independent checkouts both named "backend"
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e1', project: 'backend', git_project: 'client-a-backend' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e2', project: 'backend', git_project: 'client-a-backend' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e3', project: 'backend', git_project: 'client-b-backend' }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.groupedReport(db, ['git_project'], ...FULL_RANGE);
    } finally {
      db.close();
    }

    // then
    assert.equal(rows.length, 2);
    const byGitProject = Object.fromEntries(rows.map(r => [r.git_project, r.entries]));
    assert.deepEqual(byGitProject, { 'client-a-backend': 2, 'client-b-backend': 1 });
  });
});

test('groupedReport groups by an identity column + branch, and sorts NULL-branch rows last regardless of entry count', () => {
  inReportSandbox((report, localStorage) => {
    // given — an untagged bucket with MORE entries than the tagged one
    for (let i = 0; i < 5; i++) {
      localStorage.writeLocalStorage(sampleEntry({ entry_id: `untagged-${i}` })); // no branch/project
    }
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'tagged', project: 'backend', branch: 'send-data',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.groupedReport(db, ['project', 'branch'], ...FULL_RANGE);
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

test('groupedReport groups by identityCol+model+type for usage analysis', () => {
  inReportSandbox((report, localStorage) => {
    // given — same project, two different models, one of them used by a subagent
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e1', project: 'backend', model: 'claude-opus-4-8', type: 'main-agent',
    }));
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e2', project: 'backend', model: 'claude-opus-4-8', type: 'main-agent',
    }));
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e3', project: 'backend', model: 'claude-haiku-4-5', type: 'subagent',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.groupedReport(db, ['project', 'model', 'type'], ...FULL_RANGE);
    } finally {
      db.close();
    }

    // then — 2 distinct (model, type) groups within the one project
    assert.equal(rows.length, 2);
    const byModel = Object.fromEntries(rows.map(r => [`${r.model}/${r.type}`, r.entries]));
    assert.deepEqual(byModel, {
      'claude-opus-4-8/main-agent': 2,
      'claude-haiku-4-5/subagent': 1,
    });
  });
});

test('groupedReport only counts entries inside [from, to]', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'in-range', timestamp: '2026-06-15T00:00:00.000Z' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'too-early', timestamp: '2026-01-01T00:00:00.000Z' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'too-late', timestamp: '2026-12-31T00:00:00.000Z' }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.groupedReport(
        db, ['git_project'], '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z',
      );
    } finally {
      db.close();
    }

    // then
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entries, 1);
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
    assert.deepEqual(report.parseDateFlag(['--git_project'], '--from'), { present: false });
    assert.deepEqual(report.parseDateFlag(['--git_project', '--from', '2026-08-01'], '--from'), { present: true, value: '2026-08-01' });
    assert.deepEqual(report.parseDateFlag(['--git_project', '--from', 'not-a-date'], '--from'), { present: true, error: true });
    assert.deepEqual(report.parseDateFlag(['--git_project', '--from'], '--from'), { present: true, error: true }); // missing value
  });
});

test('formatBranchReportMarkdown returns null when every section has no data', () => {
  inReportSandbox(report => {
    // given / when / then
    const reportsData = report.branchSectionsFor('git_project').map(r => ({ ...r, rows: [] }));
    assert.equal(
      report.formatBranchReportMarkdown(reportsData, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'Git Project'),
      null,
    );
  });
});

test('formatBranchReportMarkdown renders the identity-column label in the top heading, and one heading + table per section', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry({ project: 'backend', git_project: 'backend', branch: 'send-data' }));

    const db = report.openReadOnly();
    let reportsData;
    try {
      reportsData = report.branchSectionsFor('git_project').map(({ title, groupCols }) => ({
        title, groupCols, rows: report.groupedReport(db, groupCols, ...FULL_RANGE),
      }));
    } finally {
      db.close();
    }

    // when
    const md = report.formatBranchReportMarkdown(reportsData, '2026-08-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 'Git Project');

    // then
    assert.ok(md.startsWith('# Git Project Token Usage Report'));
    assert.ok(md.includes('Range: 2026-08-11 – 2026-09-11'));
    const headings = [...md.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(headings, ['By git_project', 'By Branch', 'By Model & Type']);
    assert.ok(md.includes('| git_project | entries |'));
    assert.ok(md.includes('| git_project | branch | entries |'));
    assert.ok(md.includes('| git_project | model | type | entries |'));
    assert.ok(md.includes('backend'));
    assert.ok(md.includes('send-data'));
  });
});

test('main() --git_project with no data in the default (trailing-month) range writes no file', () => {
  inReportSandbox((report, localStorage) => {
    // given — an entry far outside the default trailing-month window
    localStorage.writeLocalStorage(sampleEntry({ timestamp: '2020-01-01T00:00:00.000Z' }));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--git_project']);

      // then
      assert.ok(logs.some(l => l.includes('local.sqlite has no entries')));
      assert.ok(!fs.existsSync(report.REPORTS_DIR));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() --git_project --from --to uses the explicit range and writes all three sections', () => {
  inReportSandbox((report, localStorage) => {
    // given — well outside the default trailing-month window, but inside --from/--to
    localStorage.writeLocalStorage(sampleEntry({
      project: 'backend', git_project: 'backend', branch: 'send-data', timestamp: '2020-05-15T00:00:00.000Z',
    }));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--git_project', '--from', '2020-05-01', '--to', '2020-05-31']);

      // then
      const match = logs[0]?.match(/^Report written to: (.+)$/);
      assert.ok(match, `expected a written-report log line, got: ${JSON.stringify(logs)}`);
      const content = fs.readFileSync(match[1], 'utf8');
      assert.ok(content.startsWith('# Git Project Token Usage Report'));
      assert.ok(content.includes('Range: 2020-05-01 – 2020-05-31'));
      assert.ok(content.includes('## By git_project'));
      assert.ok(content.includes('## By Branch'));
      assert.ok(content.includes('## By Model & Type'));
      assert.ok(content.includes('send-data'));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() --project uses `project` as the identity column, with its own label', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry({
      project: 'backend', git_project: 'backend', branch: 'send-data', timestamp: '2020-05-15T00:00:00.000Z',
    }));
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--project', '--from', '2020-05-01', '--to', '2020-05-31']);

      // then
      const match = logs[0]?.match(/^Report written to: (.+)$/);
      const content = fs.readFileSync(match[1], 'utf8');
      assert.ok(content.startsWith('# Project Token Usage Report'));
      assert.ok(content.includes('## By project'));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() with a malformed --from prints usage and exits 1, without writing local.sqlite', () => {
  inReportSandbox((report, localStorage) => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main(['--git_project', '--from', 'not-a-date']);

      // then
      assert.equal(process.exitCode, 1);
      assert.ok(errors.some(l => l.includes('--git_project')));
      assert.ok(!fs.existsSync(localStorage.LOCAL_STORAGE_DB_PATH));
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});

test('main() usage message lists --git_project and --project alongside --weekly/--monthly, not --branches', () => {
  inReportSandbox(report => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main([]);

      // then
      assert.ok(errors.some(l => l.includes('--weekly') && l.includes('--monthly') && l.includes('--git_project') && l.includes('--project')));
      assert.ok(!errors.some(l => l.includes('--branches')));
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});
