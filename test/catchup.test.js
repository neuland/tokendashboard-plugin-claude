'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, readQueue } = require('./helpers.js');

// --- Transcript fixture builders (mirrors capture.test.js's, kept independent — see
// ADR-015's discussion of why these two test files don't share a builder module) ---

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  ...over,
});

const userPrompt = (text, sessionId = null) =>
  JSON.stringify({ type: 'user', sessionId, message: { content: text } });

const userToolResult = (sessionId = null) =>
  JSON.stringify({ type: 'user', sessionId, message: { content: [{ type: 'tool_result', content: 'ok' }] } });

const assistantText = (id, model, u, stopReason = 'end_turn') =>
  JSON.stringify({
    type: 'assistant',
    message: { id, model, stop_reason: stopReason, usage: usage(u), content: [{ type: 'text', text: '...' }] },
  });

function writeTranscript(home, sessionId, lines) {
  const transcriptPath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return { transcript_path: transcriptPath, session_id: sessionId };
}

// --- isTurnOriginEntry ---

test('isTurnOriginEntry', async t => {
  await t.test('true for a plain-content user entry, false for a tool_result one, false for non-user', async () => {
    await inSandboxAsync(async hook => {
      // given / when / then
      assert.equal(hook.isTurnOriginEntry({ type: 'user', message: { content: 'hi' } }), true);
      assert.equal(
        hook.isTurnOriginEntry({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
        false,
      );
      assert.equal(hook.isTurnOriginEntry({ type: 'assistant', message: {} }), false);
    });
  });
});

// --- catchUpCapture ---

test('catchUpCapture', async t => {
  await t.test('does nothing without transcript_path or session_id', async () => {
    await inSandboxAsync(async hook => {
      // given / when
      await hook.catchUpCapture({ session_id: 's1' });
      await hook.catchUpCapture({ transcript_path: '/nope.jsonl' });

      // then
      assert.equal(hook.getQueueFiles().length, 0);
    });
  });

  await t.test('does nothing when the transcript file is missing', async () => {
    await inSandboxAsync(async (hook, home) => {
      // given
      const hookData = { transcript_path: path.join(home, 'nope.jsonl'), session_id: 's1' };

      // when
      await hook.catchUpCapture(hookData);

      // then
      assert.equal(hook.getQueueFiles().length, 0);
    });
  });

  await t.test('segments multiple turns and queues one entry per turn/model', async () => {
    await inSandboxAsync(async (hook, home) => {
      // given — three turns, three different models, no prior Stop capture at all
      const hookData = writeTranscript(home, 's1', [
        userPrompt('turn 1'),
        assistantText('id-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
        userPrompt('turn 2'),
        assistantText('id-2', 'claude-opus-5', { input_tokens: 200, output_tokens: 20 }),
        userPrompt('turn 3'),
        assistantText('id-3', 'claude-haiku-5', { input_tokens: 300, output_tokens: 30 }),
      ]);

      // when
      await hook.catchUpCapture(hookData);

      // then — one entry per turn, each carrying only that turn's usage (no bleed-over)
      const entries = readQueue(hook);
      assert.equal(entries.length, 3);
      assert.deepEqual(entries.map(e => e.model), ['claude-haiku-5', 'claude-opus-5', 'claude-sonnet-5']);
      const sonnet = entries.find(e => e.model === 'claude-sonnet-5');
      assert.equal(sonnet.usage.input_tokens, 100);
      assert.equal(sonnet.usage.output_tokens, 10);
    });
  });

  await t.test('recovers a trailing turn that never got a Stop event (interrupted turn)', async () => {
    await inSandboxAsync(async (hook, home) => {
      // given — turn 1 is a normal completed turn; turn 2 has a tool call in flight but no
      // final assistant response (as if the user hit Escape mid-turn) — the queue is empty,
      // simulating that Stop never fired for either turn this session
      const hookData = writeTranscript(home, 's1', [
        userPrompt('turn 1'),
        assistantText('id-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
        userPrompt('turn 2'),
        assistantText('id-2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 5 }, 'tool_use'),
        userToolResult(),
      ]);

      // when
      await hook.catchUpCapture(hookData);

      // then — both turns recovered; combined sonnet usage across both entries covers all of it
      const entries = readQueue(hook);
      const totalInput = entries.reduce((sum, e) => sum + e.usage.input_tokens, 0);
      const totalOutput = entries.reduce((sum, e) => sum + e.usage.output_tokens, 0);
      assert.equal(totalInput, 150);
      assert.equal(totalOutput, 15);
    });
  });

  await t.test('only touches lines whose own sessionId matches (defensive boundary)', async () => {
    await inSandboxAsync(async (hook, home) => {
      // given — a foreign turn tagged with a different sessionId mixed into the file
      const hookData = writeTranscript(home, 's1', [
        userPrompt('other session prompt', 'foreign-session'),
        assistantText('id-foreign', 'claude-sonnet-5', { input_tokens: 999, output_tokens: 999 }),
        userPrompt('turn 1', 's1'),
        assistantText('id-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
      ]);

      // when
      await hook.catchUpCapture(hookData);

      // then — only the matching-session turn is aggregated
      const entries = readQueue(hook);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].usage.input_tokens, 100);
      assert.equal(entries[0].usage.output_tokens, 10);
    });
  });

  await t.test('produces the same entryId as a normal Stop capture for an already-completed turn', async () => {
    await inSandboxAsync(async (hook, home) => {
      // given — turn 1 completes normally and Stop captures it (queue gets entry A), then
      // turn 2 starts and the session later ends — catchUpCapture re-scans the FULL
      // transcript (both turns) and must reproduce turn 1's exact entry_id so the server
      // dedupes it, not double-counts it
      const turn1Lines = [
        userPrompt('turn 1'),
        assistantText('id-1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 10 }),
      ];
      const stopHookData = writeTranscript(home, 's1', turn1Lines);
      await hook.capture(stopHookData);
      const [stopEntry] = readQueue(hook);
      assert.ok(stopEntry, 'Stop should have captured turn 1');
      fs.rmSync(hook.getQueueFiles()[0]);

      // when — the file grows with turn 2, then catch-up re-scans everything
      const fullHookData = writeTranscript(home, 's1', [
        ...turn1Lines,
        userPrompt('turn 2'),
        assistantText('id-2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 5 }),
      ]);
      await hook.catchUpCapture(fullHookData);

      // then — turn 1's re-emitted entry_id matches the original Stop capture exactly,
      // and there are exactly 2 entries (one per turn), not 1 merged aggregate
      const entries = readQueue(hook);
      assert.equal(entries.length, 2);
      const recapturedTurn1 = entries.find(e => e.usage.input_tokens === 100);
      assert.equal(recapturedTurn1.entry_id, stopEntry.entry_id);
    });
  });
});
