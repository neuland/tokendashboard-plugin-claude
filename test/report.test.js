'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const { inReportSandbox, pluginDir } = require('./helpers.js');

const sampleEntry = (overrides = {}) => ({
  entry_id: overrides.entry_id ?? 'e1',
  session_id: 's1',
  timestamp: '2026-09-11T10:00:00.000Z', // week 2026-W36, month 2026-09
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

test('periodReport on an empty (but existing) local.sqlite returns no rows', () => {
  inReportSandbox((report, localStorage) => {
    // given — schema created, no captures ever written
    const seedDb = localStorage.openLocalStorageDb();
    seedDb.close();

    // when
    const db = report.openReadOnly();
    try {
      const rows = report.periodReport(db, report.PERIODS['--weekly'].strftimeFmt);

      // then
      assert.deepEqual(rows, []);
      assert.equal(report.formatReportMarkdown(rows, 'Weekly'), null);
    } finally {
      db.close();
    }
  });
});

test('openReadOnly returns null when local.sqlite does not exist yet', () => {
  inReportSandbox(report => {
    // given — nothing has ever run in this sandbox, no plugin dir at all

    // when
    const db = report.openReadOnly();

    // then
    assert.equal(db, null);
  });
});

test('main() prints a friendly message and does not throw when local.sqlite is missing', () => {
  inReportSandbox(report => {
    // given — no plugin dir, so LOCAL_STORAGE_DB_PATH does not exist
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--weekly']);

      // then
      assert.equal(process.exitCode, undefined);
      assert.ok(logs.some(l => l.includes('local.sqlite does not exist')));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() without a period flag prints usage (listing all supported flags) and sets a non-zero exit code', () => {
  inReportSandbox(report => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main([]);

      // then
      assert.equal(process.exitCode, 1);
      assert.ok(errors.some(l => l.includes('--weekly') && l.includes('--monthly')));
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});

test('main() with both --weekly and --monthly (ambiguous) prints usage instead of picking one', () => {
  inReportSandbox(report => {
    // given
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    try {
      // when
      report.main(['--weekly', '--monthly']);

      // then
      assert.equal(process.exitCode, 1);
      assert.ok(errors.length > 0);
    } finally {
      console.error = origError;
      process.exitCode = undefined;
    }
  });
});

test('periodReport aggregates multiple entries in the same period/project/branch into one row', () => {
  inReportSandbox((report, localStorage) => {
    // given — two captures, same week, same (null) project/branch
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e1' }));
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e2',
      timestamp: '2026-09-12T08:00:00.000Z', // same %Y-%W week as e1
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 10,
      },
      price_cents: 12.25,
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.periodReport(db, report.PERIODS['--weekly'].strftimeFmt);
    } finally {
      db.close();
    }

    // then — one merged row, summed token counts and price
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.period, '2026-W36');
    assert.equal(row.project, '(none)');
    assert.equal(row.branch, '(none)');
    assert.equal(row.entries, 2);
    assert.equal(row.input_tokens, 110);
    assert.equal(row.output_tokens, 220);
    assert.equal(row.git_project, '(none)');
    assert.equal(row.cache_read_tokens, 33);
    assert.equal(row.cache_write_tokens, 44);
    assert.equal(row.price_cents, 17.75);
  });
});

test('periodReport keeps different periods, and different project/branch values, as separate rows', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e1', timestamp: '2026-09-11T10:00:00.000Z' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e2', timestamp: '2026-09-01T10:00:00.000Z' })); // different week
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e3',
      timestamp: '2026-09-11T10:00:00.000Z',
      project: 'tokendashboard-plugin-claude',
      branch: 'receive-answer',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.periodReport(db, report.PERIODS['--weekly'].strftimeFmt);
    } finally {
      db.close();
    }

    // then — 3 entries, 3 distinct groups (differing week, or differing project/branch)
    assert.equal(rows.length, 3);
    const periods = rows.map(r => r.period).sort();
    assert.deepEqual(periods, ['2026-W35', '2026-W36', '2026-W36']);
    const tagged = rows.find(r => r.project === 'tokendashboard-plugin-claude');
    assert.ok(tagged);
    assert.equal(tagged.branch, 'receive-answer');
    assert.equal(tagged.entries, 1);
  });
});

test('periodReport keeps two same-named projects with different git_project as separate rows', () => {
  inReportSandbox((report, localStorage) => {
    // given — two independent checkouts both named "backend" (project = folder basename,
    // meaningless for disambiguation), but distinct git_project (the enclosing repo dir)
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e1', project: 'backend', git_project: 'client-a-backend',
    }));
    localStorage.writeLocalStorage(sampleEntry({
      entry_id: 'e2', project: 'backend', git_project: 'client-b-backend',
    }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.periodReport(db, report.PERIODS['--weekly'].strftimeFmt);
    } finally {
      db.close();
    }

    // then — same project/period/branch/type, but git_project keeps them apart
    assert.equal(rows.length, 2);
    const gitProjects = rows.map(r => r.git_project).sort();
    assert.deepEqual(gitProjects, ['client-a-backend', 'client-b-backend']);
  });
});

test('periodReport with the monthly format buckets entries from different weeks of the same month together', () => {
  inReportSandbox((report, localStorage) => {
    // given — two entries in different %Y-W%W weeks, same calendar month
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e1', timestamp: '2026-09-01T10:00:00.000Z' }));
    localStorage.writeLocalStorage(sampleEntry({ entry_id: 'e2', timestamp: '2026-09-30T10:00:00.000Z' }));

    // when
    const db = report.openReadOnly();
    let rows;
    try {
      rows = report.periodReport(db, report.PERIODS['--monthly'].strftimeFmt);
    } finally {
      db.close();
    }

    // then
    assert.equal(rows.length, 1);
    assert.equal(rows[0].period, '2026-09');
    assert.equal(rows[0].entries, 2);
  });
});

test('formatReportMarkdown renders a heading + table per period bucket, labeled by the given period name', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry());

    // when
    const db = report.openReadOnly();
    let text;
    try {
      text = report.formatReportMarkdown(report.periodReport(db, report.PERIODS['--weekly'].strftimeFmt), 'Weekly');
    } finally {
      db.close();
    }

    // then
    assert.ok(text.startsWith('# Weekly Token Usage Report'));
    assert.ok(text.includes('## 2026-W36'));
    assert.ok(text.includes('| project | git_project | branch | type | entries |'));
    assert.ok(text.includes(report.formatCents(5.5)));

    // and — the data row must have exactly as many cells as the header row (regression
    // for the header/row column-count and cache_read/cache_write order mismatch), checked
    // generically against REPORT_COLUMNS.length so it can't silently go stale if a column
    // is added or removed later
    const cellCount = line => line.split('|').filter(s => s.trim() !== '').length;
    const headerLine = text.split('\n').find(l => l.startsWith('| project'));
    const dataLine = text.split('\n').find(l => l.startsWith('| ') && !l.startsWith('| project') && !l.startsWith('|---'));
    assert.equal(cellCount(dataLine), report.REPORT_COLUMNS.length);
    assert.equal(cellCount(dataLine), cellCount(headerLine));
    const dataCols = dataLine.split('|').filter(s => s.trim() !== '');
    assert.equal(dataCols[dataCols.length - 1].trim(), report.formatCents(5.5));
    assert.equal(dataCols[7].trim(), '4');
    assert.equal(dataCols[8].trim(), '3');
  });
});

test('REPORT_COLUMNS defines the exact period-report column set and order', () => {
  inReportSandbox(report => {
    // given / when / then — pins the column contract so a future edit that changes it is
    // a deliberate, visible test change, not a silent header/row drift
    assert.deepEqual(report.REPORT_COLUMNS.map(c => c.header), [
      'project', 'git_project', 'branch', 'type', 'entries',
      'in', 'out', 'cache_write', 'cache_read', 'price',
    ]);
  });
});

test('reportFileName is ISO-timestamp + pid based and filesystem-safe (no colons/dots)', () => {
  inReportSandbox(report => {
    // given
    const now = new Date('2026-09-14T12:34:56.789Z');

    // when
    const name = report.reportFileName(now);

    // then
    assert.equal(name, `report-2026-09-14T12-34-56-789Z-${process.pid}.md`);
  });
});

test('writeReport creates reports/ next to queue/ and writes the markdown as-is', () => {
  inReportSandbox((report, localStorage, home) => {
    // given
    const markdown = '# Weekly Token Usage Report\n\n## 2026-W36\n';

    // when
    const filePath = report.writeReport(markdown, new Date('2026-09-14T12:00:00.000Z'));

    // then
    assert.equal(path.dirname(filePath), report.REPORTS_DIR);
    assert.equal(report.REPORTS_DIR, path.join(pluginDir(home), 'reports'));
    assert.equal(fs.readFileSync(filePath, 'utf8'), markdown);
  });
});

test('main() --weekly writes a markdown report file and prints its path, without printing the report itself', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry());
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--weekly']);

      // then
      assert.equal(logs.length, 1);
      const match = logs[0].match(/^Report written to: (.+)$/);
      assert.ok(match);
      const filePath = match[1];
      assert.equal(path.dirname(filePath), report.REPORTS_DIR);
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.startsWith('# Weekly Token Usage Report'));
      assert.ok(content.includes('## 2026-W36'));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() --monthly writes a markdown report file labeled Monthly', () => {
  inReportSandbox((report, localStorage) => {
    // given
    localStorage.writeLocalStorage(sampleEntry());
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--monthly']);

      // then
      const match = logs[0].match(/^Report written to: (.+)$/);
      assert.ok(match);
      const content = fs.readFileSync(match[1], 'utf8');
      assert.ok(content.startsWith('# Monthly Token Usage Report'));
      assert.ok(content.includes('## 2026-09'));
    } finally {
      console.log = origLog;
    }
  });
});

test('main() on an existing but empty local.sqlite reports "no entries" and writes no file', () => {
  inReportSandbox((report, localStorage) => {
    // given
    const seedDb = localStorage.openLocalStorageDb();
    seedDb.close();
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      // when
      report.main(['--weekly']);

      // then
      assert.ok(logs.some(l => l.includes('local.sqlite has no entries')));
      assert.ok(!fs.existsSync(report.REPORTS_DIR));
    } finally {
      console.log = origLog;
    }
  });
});
