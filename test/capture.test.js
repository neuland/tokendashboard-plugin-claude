'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, readQueue } = require('./helpers.js');

// --- Transcript fixture builders ---

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  ...over,
});

// The original user prompt: content is a plain string (not a tool_result).
const userPrompt = text => JSON.stringify({ type: 'user', message: { content: text } });

// An intermediate user turn carrying a tool_result (multi-step tool use).
const userToolResult = () =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });

// A finalized main-turn assistant entry: carries a terminal stop_reason (end_turn) so
// capture()'s poll recognizes it as done immediately, matching a real final message.
const assistantText = (id, model, u, ts = null) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, stop_reason: 'end_turn', usage: usage(u), content: [{ type: 'text', text: '...' }] },
  });

// Like assistantText but with an explicit stop_reason: null = non-finalized streaming
// snapshot (output_tokens frozen early), a string = finalized (see ADR-009).
const assistantStop = (id, model, u, stopReason, ts = null) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, stop_reason: stopReason, usage: usage(u), content: [{ type: 'text', text: '...' }] },
  });

const assistantAgentCall = (id, model, u, toolUseId) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, model, usage: usage(u), content: [{ type: 'tool_use', name: 'Agent', id: toolUseId }] },
  });

// Write a transcript file and return the hookData for capture().
function writeTranscript(home, sessionId, lines) {
  const transcriptPath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return { transcript_path: transcriptPath, session_id: sessionId };
}

// Write a subagent meta + jsonl pair under <transcriptDir>/<sessionId>/subagents/.
function writeSubagent(home, sessionId, name, toolUseId, jsonlLines) {
  const dir = path.join(home, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ toolUseId }));
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), jsonlLines.join('\n') + '\n');
}

// --- Tests ---

test('capture does nothing without a transcript_path', async () => {
  await inSandboxAsync(async hook => {
    // given — hook data with no transcript path

    // when
    await hook.capture({ session_id: 's1' });

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('capture does nothing when the transcript file is missing', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a path that does not exist
    const hookData = { transcript_path: path.join(home, 'nope.jsonl'), session_id: 's1' };

    // when
    await hook.capture(hookData);

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('capture queues one entry for a simple single-step turn', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — prompt followed by a single final assistant response
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('hello'),
      assistantText('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50 }, '2026-06-22T10:00:00.000Z'),
    ]);

    // when
    await hook.capture(hookData);

    // then
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      entry_id: hook.entryId('sess-1', 'claude-opus-4-8', ['m1']),
      timestamp: '2026-06-22T10:00:00.000Z',
      session_id: 'sess-1',
      model: 'claude-opus-4-8',
      usage: usage({ input_tokens: 100, output_tokens: 50 }),
    });
  });
});

test('capturing the same turn twice yields a stable entry_id (idempotency key)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — one turn captured, then the exact same transcript captured again
    // (models the Stop hook firing twice / a crash-and-retry)
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('hello'),
      assistantText('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50 }),
    ]);

    // when
    await hook.capture(hookData);
    await hook.capture(hookData);

    // then — two queue files, but both carry the identical idempotency key, so the
    // endpoint can collapse them instead of double-counting
    const entries = readQueue(hook);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entry_id, entries[1].entry_id);
  });
});

test('capture sums all billed calls across a multi-step tool-use turn', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — prompt, an intermediate tool call, a tool_result, then the final response
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('do X'),
      assistantText('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 20 }),
      userToolResult(),
      assistantText('m2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 30 }),
    ]);

    // when
    await hook.capture(hookData);

    // then — both billed calls summed into one per-model entry
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.input_tokens, 300);
    assert.equal(entries[0].usage.output_tokens, 50);
  });
});

test('capture queues nothing when the final assistant entry is not yet written', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the turn ends on a user entry (Stop fired before the response landed)
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('hello'),
      assistantText('m1', 'claude-opus-4-8', { input_tokens: 100 }),
      userToolResult(),
    ]);

    // when
    await hook.capture(hookData);

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('capture emits only the main-turn entry, ignoring subagent transcripts on disk', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a turn that dispatched an Agent call, with a matching subagent transcript
    // already on disk. Subagent capture moved to the SubagentStop hook (ADR-013), so the
    // Stop path must NOT also count it — otherwise it double-counts (or writes a near-zero
    // entry for a still-running background subagent).
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('research X'),
      assistantAgentCall('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 20 }, 'agent-tool-1'),
      userToolResult(),
      assistantText('m2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 30 }),
    ]);
    writeSubagent(home, 'sess-1', 'sub1', 'agent-tool-1', [
      assistantText('s1', 'claude-haiku-4-5', { input_tokens: 40, output_tokens: 5 }),
    ]);

    // when
    await hook.capture(hookData);

    // then — exactly one entry, the main turn (opus, summed); no haiku subagent entry
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'claude-opus-4-8');
    assert.equal(entries[0].usage.input_tokens, 300);
  });
});

test('capture polls and picks up the final assistant entry written after Stop fires', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a transcript that ends on a tool_result; the final assistant entry
    // lands only after capture has started polling
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      userPrompt('do X'),
      assistantText('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 20 }),
      userToolResult(),
    ].join('\n') + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(
        transcriptPath,
        assistantText('m2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 30 }) + '\n',
      );
    }, 250);

    // when
    try {
      await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — the late entry was captured and summed with the earlier billed call
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.input_tokens, 300);
    assert.equal(entries[0].usage.output_tokens, 50);
  });
});

test('capture polls past a non-finalized main entry and records the finalized output', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the final call is first persisted non-finalized (stop_reason: null,
    // output frozen at 1); the finalized line (same message.id, real output) lands
    // only after capture has begun polling
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      userPrompt('do X'),
      assistantStop('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 1 }, null),
    ].join('\n') + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(
        transcriptPath,
        assistantStop('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50 }, 'end_turn') + '\n',
      );
    }, 250);

    // when
    try {
      await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — the finalized output (50), not the stale snapshot (1), is recorded
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 50);
  });
});

test('capture does not treat a trailing pause_turn as terminal, then records the resumed call (finding [3])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the main turn's last on-disk line settles at `pause_turn` (out 12), the
    // mid-turn stop the API emits for server-side tools; the resumed terminal call
    // (out 400) lands only after capture starts polling. The old `stop_reason !== null`
    // gate accepted pause_turn and recorded 12 alone, dropping the resumed call.
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      userPrompt('do X'),
      assistantStop('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 12 }, 'pause_turn'),
    ].join('\n') + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(
        transcriptPath,
        assistantStop('m2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 400 }, 'end_turn') + '\n',
      );
    }, 250);

    // when
    try {
      await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — waited past pause_turn for the terminal call: 12 + 400 = 412, not 12 alone
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 412);
  });
});

test('capture does not drop the turn when the transcript vanishes mid-poll (finding [3])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the transcript is readable on the first poll attempt (non-finalized, so
    // capture keeps polling), then deleted before a later attempt so its readFileSync
    // throws. Before the fix the throw unwound capture() past main().catch and the whole
    // main-turn entry was lost with no error surfaced (existsSync→read TOCTOU).
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      userPrompt('do X'),
      assistantStop('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 7 }, null),
    ].join('\n') + '\n');
    const timer = setTimeout(() => fs.rmSync(transcriptPath), 50);

    // when — must not throw; the salvaged first-attempt read is still captured
    try {
      await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — the turn is recorded from the salvaged snapshot rather than dropped
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 7);
  });
});

test('capture falls back to a never-finalized main entry rather than dropping the turn', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the final entry stays non-finalized for the whole poll window (the
    // finalized line is never written)
    const hookData = writeTranscript(home, 'sess-1', [
      userPrompt('do X'),
      assistantStop('m1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 1 }, null),
    ]);

    // when
    await hook.capture(hookData);

    // then — the turn is still captured (with the stale snapshot) instead of lost
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 1);
  });
});

