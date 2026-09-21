'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, readQueue } = require('./helpers.js');
const { detectSkillType, aggregateUsage, ADVISOR_TYPE } = require('../hook.js');

// `type` classifies who was at work for a captured row: MAIN_AGENT_TYPE for a plain
// main-turn, a skill name for a user-typed slash command, a subagent's own `agent_type`
// (falling back to SUBAGENT_TYPE), or ADVISOR_TYPE for advisor iterations — see hook.js's
// detectSkillType/aggregateUsage/writeAggregatedEntries.

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...over,
});

const assistantLine = (id, model, u, { stopReason = 'end_turn', iterations } = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      stop_reason: stopReason,
      usage: iterations ? { ...usage(u), iterations } : usage(u),
    },
  });

function firstLocalHistoryRow(hook) {
  const db = hook.openLocalHistoryDb();
  try {
    return db.prepare('SELECT * FROM usage_entries').get();
  } finally {
    db.close();
  }
}

test('detectSkillType extracts the skill name from a <command-name> wrapper, or null otherwise', () => {
  const wrapped = { message: { content: '<command-name>/improve</command-name>\nsome args' } };
  const withMessage = { message: { content: '<command-message>improve</command-message>\n<command-name>/improve</command-name>\n<command-args>x</command-args>' } };
  const plain = { message: { content: 'just a regular prompt' } };
  const nonString = { message: { content: [{ type: 'text', text: 'hi' }] } };

  assert.equal(detectSkillType(wrapped), 'improve');
  assert.equal(detectSkillType(withMessage), 'improve');
  assert.equal(detectSkillType(plain), null);
  assert.equal(detectSkillType(nonString), null);
  assert.equal(detectSkillType(null), null);
  assert.equal(detectSkillType(undefined), null);
});

test('detectSkillType ignores a <command-name> wrapper that is merely quoted mid-string, not the real wrapper at the start', () => {
  // given — a user prompt that pastes/discusses a transcript excerpt containing the exact
  // wrapper text, without it actually being a slash-command invocation
  const quoted = { message: { content: 'I found this in the transcript-file: `<command-name>/improve</command-name>`' } };

  assert.equal(detectSkillType(quoted), null);
});

test('capture() tags a plain main-turn row with MAIN_AGENT_TYPE', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }),
    ].join('\n') + '\n');

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });

    // then
    assert.equal(firstLocalHistoryRow(hook).type, hook.MAIN_AGENT_TYPE);
  });
});

test('capture() tags a user-typed slash-command turn with the skill name', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the turn-origin entry is wrapped in <command-name>, as Claude Code marks a
    // user-typed slash command that invoked a Skill
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { content: '<command-name>/improve</command-name>' } }),
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }),
    ].join('\n') + '\n');

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });

    // then
    assert.equal(firstLocalHistoryRow(hook).type, 'improve');
  });
});

test('capture() skips a Claude-Code-injected isMeta entry when scanning back for the turn origin', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the real command entry, followed by a synthetic isMeta `user` entry (Claude
    // Code's own Skill-body injection) whose array content is not a string and not a
    // tool_result either — it must not be mistaken for the turn origin
    const transcriptPath = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'user', message: { content: '<command-name>/improve</command-name>' } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'SKILL.md body' }] } }),
      assistantLine('m1', 'claude-opus-4-8', { input_tokens: 1, output_tokens: 1 }),
    ].join('\n') + '\n');

    // when
    await hook.capture({ transcript_path: transcriptPath, session_id: 'sess-1' });

    // then
    assert.equal(firstLocalHistoryRow(hook).type, 'improve');
  });
});

test('captureSubagent tags the row with hookData.agent_type', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    const transcriptPath = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('s1', 'claude-opus-4-8', { input_tokens: 1 }) + '\n');

    // when
    await hook.captureSubagent({ agent_transcript_path: transcriptPath, session_id: 'sess-1', agent_type: 'Explore' });

    // then
    assert.equal(firstLocalHistoryRow(hook).type, 'Explore');
  });
});

test('captureSubagent falls back to SUBAGENT_TYPE when agent_type is missing/empty', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — no agent_type in the payload
    const transcriptPath = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('s1', 'claude-opus-4-8', { input_tokens: 1 }) + '\n');

    // when
    await hook.captureSubagent({ agent_transcript_path: transcriptPath, session_id: 'sess-1' });

    // then
    assert.equal(firstLocalHistoryRow(hook).type, hook.SUBAGENT_TYPE);
  });
});

test('aggregateUsage tags an advisor-model accumulator with ADVISOR_TYPE, leaving the executor model untagged', () => {
  // given — a main-turn call whose iterations[] carries a nested advisor_message billed
  // to a different model (ADR-011)
  const lines = [assistantLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 2 }, {
    iterations: [{ type: 'advisor_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 20 }],
  })];

  // when
  const byModel = aggregateUsage(lines);

  // then
  assert.equal(byModel.get('claude-sonnet-5').type, null);
  assert.equal(byModel.get('claude-opus-5').type, ADVISOR_TYPE);
});

test('writeAggregatedEntries writes the advisor type into local.sqlite, overriding the caller-passed default', async () => {
  await inSandboxAsync(async hook => {
    // given — same shape as above, captured through the full main-turn path
    const lines = [assistantLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 2 }, {
      iterations: [{ type: 'advisor_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 20 }],
    })];

    // when
    hook.writeAggregatedEntries('sess-1', lines, 0, { type: hook.MAIN_AGENT_TYPE });

    // then
    const db = hook.openLocalHistoryDb();
    try {
      const rows = db.prepare('SELECT * FROM usage_entries ORDER BY model').all();
      assert.equal(rows.find(r => r.model === 'claude-sonnet-5').type, hook.MAIN_AGENT_TYPE);
      assert.equal(rows.find(r => r.model === 'claude-opus-5').type, hook.ADVISOR_TYPE);
    } finally {
      db.close();
    }
  });
});

test('type is never sent to the queue entry, only to local.sqlite', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given
    const transcriptPath = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('s1', 'claude-opus-4-8', { input_tokens: 1 }) + '\n');

    // when
    await hook.captureSubagent({ agent_transcript_path: transcriptPath, session_id: 'sess-1', agent_type: 'Explore' });

    // then
    const [queued] = readQueue(hook);
    assert.equal(queued.type, undefined);
  });
});
