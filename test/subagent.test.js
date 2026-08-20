'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, readQueue } = require('./helpers.js');

// --- Fixtures ---

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  ...over,
});

// A subagent assistant entry. stop_reason: a string = finalized, null = non-finalized
// streaming snapshot (output frozen early). `iterations` models advisor usage (ADR-011).
const subAssistant = (id, model, u, { stopReason = 'end_turn', iterations, ts = null } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model,
      stop_reason: stopReason,
      usage: iterations ? { ...usage(u), iterations } : usage(u),
      content: [{ type: 'text', text: '...' }],
    },
  });

// Write a subagent transcript file and return the SubagentStop hookData shape.
function writeAgentTranscript(home, name, lines) {
  const p = path.join(home, `${name}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return { agent_transcript_path: p, session_id: 'sess-1' };
}

// --- captureSubagent ---

test('captureSubagent queues one entry per model from the subagent transcript', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a finalized subagent transcript with two billed calls
    const hookData = writeAgentTranscript(home, 'agent-a1', [
      subAssistant('s1', 'claude-opus-4-8', { input_tokens: 40, output_tokens: 5 }),
      subAssistant('s2', 'claude-opus-4-8', { input_tokens: 60, output_tokens: 7 }, { ts: '2026-07-22T10:00:00.000Z' }),
    ]);

    // when
    await hook.captureSubagent(hookData);

    // then — one entry, summed across both calls
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'claude-opus-4-8');
    assert.equal(entries[0].usage.input_tokens, 100);
    assert.equal(entries[0].usage.output_tokens, 12);
    assert.equal(entries[0].session_id, 'sess-1');
  });
});

test('captureSubagent does nothing when agent_transcript_path is missing', async () => {
  await inSandboxAsync(async hook => {
    // given — a payload with no transcript path

    // when
    await hook.captureSubagent({ session_id: 'sess-1' });

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('captureSubagent does nothing when the transcript path does not exist', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — an agent_transcript_path pointing at no file (the agent_type:"" spurious
    // SubagentStop firings carry such a path — see ADR-013)
    const hookData = { agent_transcript_path: path.join(home, 'ghost.jsonl'), session_id: 'sess-1' };

    // when
    await hook.captureSubagent(hookData);

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('captureSubagent does nothing without a session_id', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a real transcript but no session_id
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('s1', 'claude-opus-4-8', { input_tokens: 40 }) + '\n');

    // when
    await hook.captureSubagent({ agent_transcript_path: p });

    // then
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('captureSubagent books advisor iterations to the advisor model (ADR-011)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a Haiku subagent whose call ran the advisor server-side; the advisor tokens
    // live only in usage.iterations[] under their own (Opus) model, not the flat totals
    const hookData = writeAgentTranscript(home, 'agent-a1', [
      subAssistant('s1', 'claude-haiku-4-5', { input_tokens: 10, output_tokens: 3 }, {
        iterations: [
          { type: 'message', input_tokens: 10, output_tokens: 3 },
          { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 500, output_tokens: 200 },
        ],
      }),
    ]);

    // when
    await hook.captureSubagent(hookData);

    // then — a Haiku entry (executor) and a separate Opus entry (advisor)
    const entries = readQueue(hook);
    assert.equal(entries.length, 2);
    const [haiku, opus] = entries;
    assert.equal(haiku.model, 'claude-haiku-4-5');
    assert.equal(haiku.usage.output_tokens, 3);
    assert.equal(opus.model, 'claude-opus-4-8');
    assert.equal(opus.usage.output_tokens, 200);
    assert.equal(opus.usage.input_tokens, 500);
  });
});

test('captureSubagent is idempotent — the same transcript yields a stable entry_id', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — one subagent transcript captured twice (SubagentStop can fire more than once)
    const hookData = writeAgentTranscript(home, 'agent-a1', [
      subAssistant('s1', 'claude-opus-4-8', { input_tokens: 40, output_tokens: 5 }),
    ]);

    // when
    await hook.captureSubagent(hookData);
    await hook.captureSubagent(hookData);

    // then — two files, identical idempotency key (endpoint collapses them)
    const entries = readQueue(hook);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entry_id, entries[1].entry_id);
  });
});

test('captureSubagent waits out a non-finalized last line and records the finalized output', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the last line is first persisted non-finalized (stop_reason: null, output
    // frozen at 1); the finalized line (same id, real output) lands after polling starts
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('s1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 1 }, { stopReason: null }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('s1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 90 }, { stopReason: 'end_turn' }) + '\n');
    }, 250);

    // when
    try {
      await hook.captureSubagent({ agent_transcript_path: p, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — the finalized output (90), not the stale snapshot (1), is recorded
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 90);
  });
});

test('captureSubagent waits for the FINAL call even when an earlier call is finalized (e2e regression)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a multi-step subagent: an earlier tool-use call is already finalized
    // (out 173), but the final (large) call is first a stale snapshot (out 3); its
    // finalized line (out 3485) lands only after polling starts. This is the exact
    // shape that recorded 176 instead of 3658 in the real end-to-end run: the poll
    // must key off the LAST call, not return early on the earlier finalized one.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, [
      subAssistant('c1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 173 }, { stopReason: 'tool_use' }),
      subAssistant('c2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 3 }, { stopReason: null }),
    ].join('\n') + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('c2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 3485 }, { stopReason: 'end_turn' }) + '\n');
    }, 250);

    // when
    try {
      await hook.captureSubagent({ agent_transcript_path: p, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — final call's finalized output (3485) summed with c1 (173) = 3658, NOT 176
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 3658);
  });
});

test('captureSubagent keeps polling when only a finalized tool_use call is on disk, then records the terminal call (finding [4])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — at SubagentStop time only the earlier tool_use call (finalized, out 173)
    // is on disk; the final terminal call (out 3485) is written shortly after. A
    // `stop_reason !== null` gate would return c1 immediately and drop c2, because a
    // finalized tool_use is not the subagent's true last message.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('c1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 173 }, { stopReason: 'tool_use' }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('c2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 3485 }, { stopReason: 'end_turn' }) + '\n');
    }, 250);

    // when
    try {
      await hook.captureSubagent({ agent_transcript_path: p, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — waited for the terminal call: 173 + 3485 = 3658, not 173 alone
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 3658);
  });
});

test('readFinalizedLines does not treat an absent stop_reason as terminal (finding [6])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a first snapshot with NO stop_reason field at all (out 1), then the same
    // message finalized (out 90) shortly after. `undefined !== null` would wrongly pass.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { id: 's1', model: 'claude-opus-4-8', usage: { output_tokens: 1 } } }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, JSON.stringify({ type: 'assistant', message: { id: 's1', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { output_tokens: 90 } } }) + '\n');
    }, 120);

    // when
    let lines;
    try {
      lines = await hook.readFinalizedLines(p, 15, 60);
    } finally {
      clearTimeout(timer);
    }

    // then — polled past the absent-stop_reason snapshot; dedup-by-id yields the terminal 90
    const agg = [...hook.aggregateUsage(lines, 0).values()];
    assert.equal(agg[0].usage.output_tokens, 90);
  });
});

test('readFinalizedLines does not treat pause_turn as terminal, then records the resumed terminal call', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the last on-disk line settles at `pause_turn` (out 12), the mid-turn stop
    // the API emits for server-side tools; the SDK resumes and appends the real terminal
    // call (out 3400) shortly after. A denylist (`truthy && !== 'tool_use'`) would accept
    // `pause_turn` and drop the resumed call; the allowlist must keep polling.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('c1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 12 }, { stopReason: 'pause_turn' }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('c2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 3400 }, { stopReason: 'end_turn' }) + '\n');
    }, 250);

    // when
    try {
      await hook.captureSubagent({ agent_transcript_path: p, session_id: 'sess-1' });
    } finally {
      clearTimeout(timer);
    }

    // then — waited past pause_turn for the terminal call: 12 + 3400 = 3412, not 12 alone
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usage.output_tokens, 3412);
  });
});

test('readFinalizedLines treats refusal as terminal and returns before more output lands', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — the last on-disk line is a finalized `refusal` (out 90). refusal is a real
    // terminal stop_reason; the old allowlist omitted it, so the poll would burn its full
    // window instead of short-circuiting. A second terminal call (out 500) is appended
    // shortly after — if the poll returned on the refusal at once it never reads it.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('c1', 'claude-opus-4-8', { output_tokens: 90 }, { stopReason: 'refusal' }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('c2', 'claude-opus-4-8', { output_tokens: 500 }, { stopReason: 'end_turn' }) + '\n');
    }, 120);

    // when — a long delay so, if refusal were NOT terminal, the append would land and sum in
    let lines;
    try {
      lines = await hook.readFinalizedLines(p, 15, 200);
    } finally {
      clearTimeout(timer);
    }

    // then — returned on the refusal alone (out 90), before c2 (500) was ever written
    const agg = [...hook.aggregateUsage(lines, 0).values()];
    assert.equal(agg.length, 1);
    assert.equal(agg[0].usage.output_tokens, 90);
  });
});

test('readFinalizedLines does not return on a terminal entry that lacks message.id', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a terminal entry with usage + model but NO message.id (which aggregateUsage
    // would silently drop). The poll must not treat it as done and return early; the real
    // finalized line (with an id) lands shortly after.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { output_tokens: 7 } } }) + '\n');
    const timer = setTimeout(() => {
      fs.appendFileSync(p, subAssistant('s1', 'claude-opus-4-8', { output_tokens: 88 }, { stopReason: 'end_turn' }) + '\n');
    }, 120);

    // when
    let lines;
    try {
      lines = await hook.readFinalizedLines(p, 15, 60);
    } finally {
      clearTimeout(timer);
    }

    // then — polled past the id-less entry to the countable one (out 88); the id-less
    // entry contributes nothing (aggregateUsage drops it)
    const agg = [...hook.aggregateUsage(lines, 0).values()];
    assert.equal(agg.length, 1);
    assert.equal(agg[0].usage.output_tokens, 88);
  });
});

test('readFinalizedLines returns null without throwing when the transcript never becomes readable (finding [5])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a path that does not exist for the whole window (models a transcript
    // deleted between the SubagentStop fire and the read)
    const p = path.join(home, 'gone.jsonl');

    // when — must not throw (no existsSync/readFileSync TOCTOU)
    const lines = await hook.readFinalizedLines(p, 2, 10);

    // then
    assert.equal(lines, null);
  });
});

// --- readFinalizedLines (timing behaviour, driven directly for speed) ---

test('readFinalizedLines falls back to the stale snapshot after the poll window', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a transcript that stays non-finalized for the whole (short) window
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('s1', 'claude-opus-4-8', { output_tokens: 1 }, { stopReason: null }) + '\n');

    // when — small attempts/delay so the fallback path is fast
    const lines = await hook.readFinalizedLines(p, 2, 10);

    // then — returns the stale lines rather than null (turn is not dropped)
    assert.ok(Array.isArray(lines));
    assert.equal(lines.length, 1);
  });
});

test('readFinalizedLines returns the salvaged snapshot when the FINAL poll read throws (finding [1])', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a non-finalized transcript readable on the first attempt, then deleted
    // during the inter-attempt delay so the LAST attempt's readFileSync throws. Before
    // the fix the throwing read fell through to `return null` and the whole turn was
    // dropped even though attempt 0 had salvaged usable lines.
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, subAssistant('s1', 'claude-opus-4-8', { output_tokens: 42 }, { stopReason: null }) + '\n');
    const timer = setTimeout(() => fs.rmSync(p), 20);

    // when — attempt 0 reads OK; the 60ms delay lets the deletion land; attempt 1 throws
    let lines;
    try {
      lines = await hook.readFinalizedLines(p, 2, 60);
    } finally {
      clearTimeout(timer);
    }

    // then — the salvaged non-finalized snapshot is returned, not null
    assert.ok(Array.isArray(lines));
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message.usage.output_tokens, 42);
  });
});

test('readFinalizedLines returns null when no assistant-with-usage entry ever appears', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a transcript with only a user entry (no assistant usage)
    const p = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');

    // when
    const lines = await hook.readFinalizedLines(p, 2, 10);

    // then
    assert.equal(lines, null);
  });
});
