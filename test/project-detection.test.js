'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { inSandbox, inSandboxAsync, readQueue } = require('./helpers.js');

// A throwaway git repo on the given branch, used as `cwd` for detectBranch()/
// writeAggregatedEntries() — real git subprocess calls over mocking, per repo convention.
function makeGitRepo(branch = 'my-branch') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-repo-'));
  spawnSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // An unborn branch (no commits yet) still resolves via the symbolic ref, but commit
  // once anyway so the fixture matches a real project, not an edge case.
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('detectProject returns the basename of cwd, or null without a cwd', () => {
  inSandbox(hook => {
    // given / when / then
    assert.equal(hook.detectProject('/home/dev/code/tokendashboard-plugin-claude'), 'tokendashboard-plugin-claude');
    assert.equal(hook.detectProject('/home/dev/code/'), 'code');
    assert.equal(hook.detectProject(null), null);
    assert.equal(hook.detectProject(undefined), null);
  });
});

test('detectBranch returns the active git branch of cwd', () => {
  inSandbox(hook => {
    // given
    const repo = makeGitRepo('receive-answer');

    try {
      // when / then
      assert.equal(hook.detectBranch(repo), 'receive-answer');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('detectBranch returns null for a non-git directory, and without throwing', () => {
  inSandbox(hook => {
    // given
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-notrepo-'));

    try {
      // when / then
      assert.equal(hook.detectBranch(notARepo), null);
      assert.equal(hook.detectBranch(null), null);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

// A linked worktree of an existing repo, on a fresh throwaway branch — simulates an
// isolated agent worktree (Claude Code's own `.claude/worktrees/agent-<hash>`, or any
// team's manually-created ones) whose own branch/folder name are meaningless for
// reporting (resolveBaseWorktree/detectProject/detectBranch should see through it).
function addLinkedWorktree(repoDir, branch) {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-worktree-'));
  fs.rmdirSync(worktreeDir); // git worktree add requires a non-existent target path
  spawnSync('git', ['worktree', 'add', '-q', '-b', branch, worktreeDir], { cwd: repoDir });
  return worktreeDir;
}

test('resolveBaseWorktree returns the main worktree path from inside a linked worktree, and cwd unchanged for a plain repo', () => {
  inSandbox(hook => {
    // given
    const repo = makeGitRepo('receive-answer');
    const linked = addLinkedWorktree(repo, 'worktree-agent-xyz');

    // git normalizes worktree paths (e.g. resolves macOS's /var -> /private/var symlink),
    // so compare against the realpath rather than the raw mkdtemp path.
    const realRepo = fs.realpathSync(repo);

    try {
      // when / then — from the linked worktree, resolves back to the main one
      assert.equal(hook.resolveBaseWorktree(linked), realRepo);
      // and — from the main worktree itself, resolves to itself (no regression)
      assert.equal(hook.resolveBaseWorktree(repo), realRepo);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('detectProject/detectBranch resolve to the BASE worktree, not an isolated agent worktree\'s own random name/branch', () => {
  inSandbox(hook => {
    // given
    const repo = makeGitRepo('receive-answer');
    const linked = addLinkedWorktree(repo, 'worktree-agent-xyz');

    try {
      // when / then — run FROM the linked worktree, but attribute to the base project
      assert.equal(hook.detectProject(linked), path.basename(repo));
      assert.equal(hook.detectBranch(linked), 'receive-answer');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('project/branch detection works outside any git repository (Claude Code need not run inside one)', () => {
  inSandbox(hook => {
    // given — a plain folder, no `git init` at all
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-nongit-project-'));

    try {
      // when / then
      assert.equal(hook.detectProject(dir), path.basename(dir)); // still derived from cwd
      assert.equal(hook.detectBranch(dir), null); // no repo, no crash
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('writeAggregatedEntries writes project/branch into local.sqlite but NEVER into the queue entry', () => {
  inSandbox(hook => {
    // given — a real repo/branch fixture, and one countable assistant line
    const repo = makeGitRepo('receive-answer');
    const lines = [JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-15T09:00:00.000Z',
      message: {
        id: 'msg-1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    })];

    try {
      // when
      hook.writeAggregatedEntries('sess-1', lines, 0, { cwd: repo });

      // then — queue entry has no project/branch fields at all (privacy: only data that's
      // also sent to the backend belongs in the queue)
      const [queued] = readQueue(hook);
      assert.equal(queued.project, undefined);
      assert.equal(queued.branch, undefined);

      // and — local.sqlite got the real values
      const db = hook.openLocalHistoryDb();
      try {
        const row = db.prepare('SELECT * FROM usage_entries').get();
        assert.equal(row.project, path.basename(repo));
        assert.equal(row.branch, 'receive-answer');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- End-to-end: capture()/captureSubagent()/catchUpCapture() pass hookData.cwd through ---

const assistantLine = (id, model, u) => JSON.stringify({
  type: 'assistant',
  message: { id, model, stop_reason: 'end_turn', usage: u },
});

test('capture() uses hookData.cwd for project/branch detection', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    const repo = makeGitRepo('some/branch');
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }),
    ].join('\n') + '\n');

    try {
      // when
      await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1', cwd: repo });

      // then
      const db = hook.openLocalHistoryDb();
      try {
        const row = db.prepare('SELECT * FROM usage_entries').get();
        assert.equal(row.project, path.basename(repo));
        assert.equal(row.branch, 'some/branch');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('capture() falls back to process.cwd() when hookData carries no cwd', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — no cwd in the payload at all
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }),
    ].join('\n') + '\n');

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });

    // then — project reflects the real process cwd (this repo checkout), proving the
    // fallback ran rather than leaving project null. Compared via detectProject (not a
    // hardcoded basename) since this repo checkout may itself be a worktree.
    const db = hook.openLocalHistoryDb();
    try {
      const row = db.prepare('SELECT * FROM usage_entries').get();
      assert.equal(row.project, hook.detectProject(process.cwd()));
    } finally {
      db.close();
    }
  });
});
