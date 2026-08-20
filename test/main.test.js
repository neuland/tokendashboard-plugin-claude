'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempHome, runHookProcess, readQueue } = require('./helpers.js');

// main() is exercised end-to-end as a child process so its argv dispatch and
// stdin handling run for real. Only network-safe modes are used here: the default
// capture path makes no requests, and --flush returns before any fetch on an empty
// queue. (--do-update / the update probe hit real hosts and are covered directly.)

// A minimal transcript: original prompt followed by the final assistant response
// (finalized with a terminal stop_reason so capture()'s poll short-circuits at once).
function writeTranscript(home) {
  const transcriptPath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-23T10:00:00.000Z',
      message: {
        id: 'm1',
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: '...' }],
      },
    }),
  ].join('\n') + '\n');
  return transcriptPath;
}

test('main (default mode) parses stdin and captures the turn into the queue', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a transcript and matching hook payload on stdin
    const transcriptPath = writeTranscript(home);
    const input = JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess-1' });

    // when — run the hook with no mode argument
    const res = runHookProcess([], { home, input });

    // then — clean exit and exactly one queued entry for the turn
    assert.equal(res.status, 0);
    const entries = readQueue(home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'claude-opus-4-8');
    assert.equal(entries[0].usage.input_tokens, 100);
  } finally {
    cleanup();
  }
});

test('main (default mode) tolerates malformed stdin without crashing', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — stdin that is not valid JSON

    // when
    const res = runHookProcess([], { home, input: 'not json {' });

    // then — exits cleanly and queues nothing
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
  } finally {
    cleanup();
  }
});

test('main (--subagent-stop) parses stdin and captures the subagent transcript', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a finalized subagent transcript and a SubagentStop payload on stdin
    const agentPath = path.join(home, 'agent-a1.jsonl');
    fs.writeFileSync(agentPath, JSON.stringify({
      type: 'assistant',
      message: {
        id: 's1',
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        usage: { input_tokens: 40, output_tokens: 5 },
        content: [{ type: 'text', text: '...' }],
      },
    }) + '\n');
    const input = JSON.stringify({ agent_transcript_path: agentPath, session_id: 'sess-1' });

    // when
    const res = runHookProcess(['--subagent-stop'], { home, input });

    // then — clean exit and exactly one queued subagent entry
    assert.equal(res.status, 0);
    const entries = readQueue(home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'claude-opus-4-8');
    assert.equal(entries[0].usage.output_tokens, 5);
  } finally {
    cleanup();
  }
});

test('main (--flush) exits cleanly and makes no request on an empty queue', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — no queued entries

    // when
    const res = runHookProcess(['--flush'], { home });

    // then — the flush dispatch route returns before touching the network
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
  } finally {
    cleanup();
  }
});

test('main (--fetch-prices) dispatches to fetchPrices and exits cleanly with nothing configured', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — no config.json at all, so fetchPrices()'s not-installed guard returns
    // immediately, before any network access (network-safe, like the empty-queue --flush case)

    // when
    const res = runHookProcess(['--fetch-prices'], { home });

    // then
    assert.equal(res.status, 0);
  } finally {
    cleanup();
  }
});
