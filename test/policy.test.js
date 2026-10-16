'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, recentAttempts } = require('../policy');
const now = 2000000;
const state = { failures: 3, dirty: false, debugging: false, attempts: [], now };

test('only repeated failures reload', () => {
  assert.equal(decide({ ...state, failures: 2 }), 'wait');
  assert.equal(decide(state), 'reload');
});
test('unsaved work and debugging prevent reload', () => {
  assert.equal(decide({ ...state, dirty: true }), 'unsaved changes');
  assert.equal(decide({ ...state, debugging: true }), 'active debug session');
});
test('persisted history limits new extension hosts too', () => {
  assert.equal(decide({ ...state, attempts: [now - 180000, now - 120000, now - 61000] }), 'reload limit reached');
  assert.equal(decide({ ...state, attempts: [now - 1000] }), 'cooldown');
});
test('old, malformed and future history cannot block recovery forever', () => {
  assert.deepEqual(recentAttempts([null, 'bad', NaN, now + 1, now - 900001, now - 61000], now), [now - 61000]);
  assert.equal(decide({ ...state, attempts: [now - 900001] }), 'reload');
});
