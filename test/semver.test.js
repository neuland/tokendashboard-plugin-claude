'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// semverGt moved to updater.js along with the rest of the update logic (see ADR-012).
const { semverGt, satisfiesMinNodeVersion } = require('../updater.js');

test('semverGt: greater patch / minor / major', () => {
  // given / when / then — each pair: left is the newer version
  assert.equal(semverGt('1.0.1', '1.0.0'), true);
  assert.equal(semverGt('1.1.0', '1.0.9'), true);
  assert.equal(semverGt('2.0.0', '1.9.9'), true);
});

test('semverGt: equal versions are not greater', () => {
  // given
  const a = '1.2.3', b = '1.2.3';

  // when
  const result = semverGt(a, b);

  // then
  assert.equal(result, false);
});

test('semverGt: smaller versions are not greater', () => {
  // given / when / then — left is the older version in every pair
  assert.equal(semverGt('1.0.0', '1.0.1'), false);
  assert.equal(semverGt('1.0.9', '1.1.0'), false);
  assert.equal(semverGt('1.9.9', '2.0.0'), false);
});

test('semverGt: minor outranks patch', () => {
  // given — 0.2.0 must count as an update over 0.1.99 (real rollout scenario)
  const remote = '0.2.0', current = '0.1.99';

  // when
  const result = semverGt(remote, current);

  // then
  assert.equal(result, true);
});

test('satisfiesMinNodeVersion: rejects below-minimum, accepts at/above-minimum', () => {
  // given / when / then — each pair: running version vs. the ">=22.13" engines.node range
  assert.equal(satisfiesMinNodeVersion('v18.20.4', '>=22.13'), false);
  assert.equal(satisfiesMinNodeVersion('v20.11.0', '>=22.13'), false);
  assert.equal(satisfiesMinNodeVersion('v22.12.0', '>=22.13'), false);
  assert.equal(satisfiesMinNodeVersion('v22.13.0', '>=22.13'), true);
  assert.equal(satisfiesMinNodeVersion('v24.1.0', '>=22.13'), true);
});
