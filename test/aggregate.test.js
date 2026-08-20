'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { aggregateUsage } = require('../hook.js');

// Build an assistant transcript line. usage fields default to 0 so tests only
// specify what they care about. stop_reason defaults to a finalized value;
// pass null to model a non-finalized streaming artifact.
function assistant(id, model, usage = {}, timestamp = null, stop_reason = 'end_turn') {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model,
      stop_reason,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  });
}

// Like assistant(), but with an `iterations` array on usage. `iterations` entries model
// the per-sub-call breakdown of a single API call: executor sub-calls (`type:'message'`)
// plus the advisor's own billed call (`type:'advisor_message'` with its own model). The
// flat top-level usage still describes only the executor (advisor tokens are NOT in it).
function assistantWithIterations(id, model, usage, iterations) {
  const obj = JSON.parse(assistant(id, model, usage));
  obj.message.usage.iterations = iterations;
  return JSON.stringify(obj);
}

test('sums billed API calls (distinct ids) for one model', () => {
  // given — two separate billed calls for the same model
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 10 }),
    assistant('id-2', 'claude-opus-4-8', { input_tokens: 200, output_tokens: 20 }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then
  assert.equal(byModel.size, 1);
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 300,
    output_tokens: 30,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('dedupes streaming artifacts sharing a message.id (last wins)', () => {
  // given — one billed call written 3x as streaming snapshots: input/cache
  // constant, output_tokens grows. Summing raw would triple input/cache.
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 1000 }),
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 1000 }),
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 1000 }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — input/cache counted once, output_tokens from the final artifact
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 500,
    output_tokens: 80,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('sums the ephemeral cache-write TTL breakdown from a single call (ADR-014)', () => {
  // given — one call reporting both a 5-minute and a 1-hour ephemeral cache write
  const lines = [
    assistant('id-1', 'claude-opus-4-8', {
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — both TTL counts land alongside the unchanged combined total
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 200,
    ephemeral_1h_input_tokens: 100,
  });
});

test('sums the ephemeral cache-write TTL breakdown across multiple calls in one entry', () => {
  // given — two billed calls for the same model, each with its own TTL breakdown
  const lines = [
    assistant('id-1', 'claude-opus-4-8', {
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
    }),
    assistant('id-2', 'claude-opus-4-8', {
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
    }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — each TTL count summed independently, matching the combined total's own summing
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_5m_input_tokens, 250);
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_1h_input_tokens, 100);
  assert.equal(byModel.get('claude-opus-4-8').usage.cache_creation_input_tokens, 350);
});

test('sums the ephemeral cache-write TTL breakdown for an advisor iteration under its own model', () => {
  // given — the advisor's own billed call carries its own cache_creation breakdown,
  // distinct from the executor's (mirrors how advisor cache_creation_input_tokens is handled)
  const lines = [
    assistantWithIterations(
      'id-1',
      'claude-haiku-4-5',
      { cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } },
      [
        {
          type: 'advisor_message',
          model: 'claude-opus-4-8',
          input_tokens: 100,
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 },
        },
      ],
    ),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — executor and advisor keep independent TTL breakdowns under their own models
  assert.equal(byModel.get('claude-haiku-4-5').usage.ephemeral_5m_input_tokens, 10);
  assert.equal(byModel.get('claude-haiku-4-5').usage.ephemeral_1h_input_tokens, 0);
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_5m_input_tokens, 0);
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_1h_input_tokens, 900);
});

test('defaults both ephemeral TTL counts to 0 when cache_creation is entirely absent', () => {
  // given — a call with no cache write at all, so no cache_creation object is reported
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 5, output_tokens: 2 }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — no error, no NaN, both new counts default to 0
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 5,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('defaults the absent half of a partial ephemeral TTL breakdown to 0', () => {
  // given — cache_creation is present but only reports the 5-minute sub-field
  const lines = [
    assistant('id-1', 'claude-opus-4-8', {
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 200 },
    }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — the present value is recorded, the absent one defaults to 0
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_5m_input_tokens, 200);
  assert.equal(byModel.get('claude-opus-4-8').usage.ephemeral_1h_input_tokens, 0);
  assert.equal(byModel.get('claude-opus-4-8').usage.cache_creation_input_tokens, 200);
});

test('splits usage per model', () => {
  // given — billed calls against two different models
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 100 }),
    assistant('id-2', 'claude-haiku-4-5', { input_tokens: 40 }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 100);
  assert.equal(byModel.get('claude-haiku-4-5').usage.input_tokens, 40);
});

test('honors startIdx (ignores lines before the turn origin)', () => {
  // given — an older entry precedes the current turn
  const lines = [
    assistant('old', 'claude-opus-4-8', { input_tokens: 999 }),
    assistant('new', 'claude-opus-4-8', { input_tokens: 1 }),
  ];

  // when — aggregation starts at the second line
  const byModel = aggregateUsage(lines, 1);

  // then
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 1);
});

test('skips non-assistant, malformed, and incomplete entries', () => {
  // given — only the last line is a complete assistant entry
  const lines = [
    'not json at all',
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'x', usage: {} } }), // no id
    JSON.stringify({ type: 'assistant', message: { id: 'y', usage: {} } }), // no model
    assistant('ok', 'claude-opus-4-8', { input_tokens: 7 }),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then
  assert.equal(byModel.size, 1);
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 7);
});

test('keeps the last seen timestamp for a model', () => {
  // given — two entries, chronological
  const lines = [
    assistant('id-1', 'claude-opus-4-8', {}, '2026-06-22T10:00:00.000Z'),
    assistant('id-2', 'claude-opus-4-8', {}, '2026-06-22T11:00:00.000Z'),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then
  assert.equal(byModel.get('claude-opus-4-8').timestamp, '2026-06-22T11:00:00.000Z');
});

test('empty input yields an empty map', () => {
  // given / when
  const byModel = aggregateUsage([]);

  // then
  assert.equal(byModel.size, 0);
});

test('repairs a non-finalized final call with finalizedUsage (output was stale)', () => {
  // given — a short subagent whose only artifact never finalized: stop_reason null,
  // output_tokens frozen at 1, while input/cache are already correct. The main
  // transcript's toolUseResult carries the real finalized usage.
  const lines = [
    assistant('id-1', 'claude-haiku-4-5', { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 11624 }, null, null),
  ];
  const finalizedUsage = { input_tokens: 3, output_tokens: 141, cache_creation_input_tokens: 11624, cache_read_input_tokens: 0 };

  // when
  const byModel = aggregateUsage(lines, 0, finalizedUsage);

  // then — output_tokens comes from the finalized usage, not the stale 1
  assert.deepEqual(byModel.get('claude-haiku-4-5').usage, {
    input_tokens: 3,
    output_tokens: 141,
    cache_creation_input_tokens: 11624,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('does not override a finalized final call even when finalizedUsage is given', () => {
  // given — the last entry IS finalized (stop_reason set); finalizedUsage must be ignored
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 2232 }, null, 'end_turn'),
  ];
  const finalizedUsage = { input_tokens: 999, output_tokens: 999 };

  // when
  const byModel = aggregateUsage(lines, 0, finalizedUsage);

  // then — the transcript's own finalized numbers win
  assert.equal(byModel.get('claude-opus-4-8').usage.output_tokens, 2232);
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 100);
});

test('attributes advisor_message iterations to their own model, separate from the executor', () => {
  // given — one executor (Haiku) API call that consulted the advisor (Opus). The flat
  // usage is the executor's; the advisor's billing is only in iterations[].
  const lines = [
    assistantWithIterations(
      'id-1',
      'claude-haiku-4-5',
      { input_tokens: 9, output_tokens: 2561, cache_creation_input_tokens: 11523, cache_read_input_tokens: 72989 },
      [
        { type: 'message', input_tokens: 8, output_tokens: 1907 },
        { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 58878, output_tokens: 5926 },
        { type: 'message', input_tokens: 1, output_tokens: 654 },
      ],
    ),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — executor keeps only its flat totals; advisor is booked under its own model
  assert.equal(byModel.size, 2);
  assert.deepEqual(byModel.get('claude-haiku-4-5').usage, {
    input_tokens: 9,
    output_tokens: 2561,
    cache_creation_input_tokens: 11523,
    cache_read_input_tokens: 72989,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 58878,
    output_tokens: 5926,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('counts advisor iterations once per message.id across streaming artifacts', () => {
  // given — one billed call written 3x as streaming snapshots (shared message.id); the
  // advisor iteration is constant across them, exactly like input/cache fields.
  const advisorIter = { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 100, output_tokens: 5 };
  const lines = [
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9, output_tokens: 1 }, [advisorIter]),
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9, output_tokens: 40 }, [advisorIter]),
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9, output_tokens: 80 }, [advisorIter]),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — advisor counted once, not tripled
  assert.deepEqual(byModel.get('claude-opus-4-8').usage, {
    input_tokens: 100,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('sums advisor usage across multiple advisor calls in one turn', () => {
  // given — the turn consulted the advisor twice, in two separate executor API calls
  const lines = [
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9 },
      [{ type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 58878, output_tokens: 5926 }]),
    assistantWithIterations('id-2', 'claude-haiku-4-5', { input_tokens: 9 },
      [{ type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 65896, output_tokens: 7785 }]),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — advisor totals accumulate under the one advisor model
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 58878 + 65896);
  assert.equal(byModel.get('claude-opus-4-8').usage.output_tokens, 5926 + 7785);
});

test('ignores non-advisor (executor) iterations so they are not double-counted', () => {
  // given — an API call whose iterations are all executor sub-calls (no advisor)
  const lines = [
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9, output_tokens: 2561 }, [
      { type: 'message', input_tokens: 8, output_tokens: 1907 },
      { type: 'message', input_tokens: 1, output_tokens: 654 },
    ]),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — only the flat executor totals count; iterations add nothing
  assert.equal(byModel.size, 1);
  assert.deepEqual(byModel.get('claude-haiku-4-5').usage, {
    input_tokens: 9,
    output_tokens: 2561,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  });
});

test('gives advisor usage a distinct idempotency key from the executor', () => {
  // given — executor + advisor share the parent message.id but differ in model
  const lines = [
    assistantWithIterations('id-1', 'claude-haiku-4-5', { input_tokens: 9 },
      [{ type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 58878 }]),
  ];

  // when
  const byModel = aggregateUsage(lines);

  // then — both reference id-1, but entryId namespaces by model so keys never collide
  const { entryId } = require('../hook.js');
  const execKey = entryId('sess', 'claude-haiku-4-5', byModel.get('claude-haiku-4-5').ids);
  const advKey = entryId('sess', 'claude-opus-4-8', byModel.get('claude-opus-4-8').ids);
  assert.notEqual(execKey, advKey);
});

test('repairs only the final call, leaving earlier finalized tool-use calls intact', () => {
  // given — a multi-step subagent: first call finalized (tool_use, output 151),
  // final call non-finalized (output frozen at 1). Only the final call is repaired.
  const lines = [
    assistant('id-1', 'claude-opus-4-8', { input_tokens: 700, output_tokens: 151 }, null, 'tool_use'),
    assistant('id-2', 'claude-opus-4-8', { input_tokens: 743, output_tokens: 1 }, null, null),
  ];
  const finalizedUsage = { input_tokens: 743, output_tokens: 2232 };

  // when
  const byModel = aggregateUsage(lines, 0, finalizedUsage);

  // then — first call kept (151), final call repaired (2232) → 151 + 2232
  assert.equal(byModel.get('claude-opus-4-8').usage.output_tokens, 151 + 2232);
  assert.equal(byModel.get('claude-opus-4-8').usage.input_tokens, 700 + 743);
});
