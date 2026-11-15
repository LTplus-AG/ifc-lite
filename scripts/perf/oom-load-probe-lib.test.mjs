/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: the capped load test is a known-issue test. Its verdict must not be
// able to pass silently: a kill is never a pass in acceptance mode, and in
// known-issue mode the fix landing (loaded/refused) fails until the flag flips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseSize, phaseOf, verdict } from './oom-load-probe-lib.mjs';

test('#10264 an OOM kill wins over every other signal', () => {
  assert.equal(classify({ oomKills: 1, interactive: true }).outcome, 'killed');
  assert.equal(classify({ oomKills: 2, storeError: 'Ran out of memory while processing x' }).outcome, 'killed');
  assert.equal(classify({ pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ browserGone: true }).outcome, 'killed');
});

test('#10264 memory messages are refusals: main\'s OOM text and a pre-read budget refusal', () => {
  // apps/viewer/src/lib/load-error-message.ts (out_of_memory)
  assert.equal(classify({ storeError: 'Ran out of memory while processing big.ifc. This usually means the model is too large for this device\'s available memory.' }).outcome, 'refused');
  // Pre-read refusal wording proposed for #10264
  const r = classify({ storeError: null, pageText: 'Open\nThis IFC file exceeds this tab\'s local processing memory budget (6.0 GiB budget).\nOK' });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /local processing memory budget/);
});

test('#10264 other outcomes: loaded, non-memory error, timeout', () => {
  assert.equal(classify({ interactive: true }).outcome, 'loaded');
  assert.equal(classify({ storeError: 'Unsupported schema IFC9' }).outcome, 'error');
  assert.equal(classify({ timedOut: true }).outcome, 'timeout');
  assert.equal(classify({}).outcome, 'error');
});

test('#10264 known-issue mode passes only on a kill and fails loudly once the fix lands', () => {
  assert.equal(verdict('killed', 'killed').pass, true);
  for (const fixed of ['loaded', 'refused']) {
    const v = verdict(fixed, 'killed');
    assert.equal(v.pass, false);
    assert.match(v.message, /--expect not-killed/);
  }
  for (const broken of ['error', 'timeout']) assert.equal(verdict(broken, 'killed').pass, false);
});

test('#10264 acceptance mode passes on loaded or refused, never on killed/error/timeout', () => {
  assert.equal(verdict('loaded', 'not-killed').pass, true);
  assert.equal(verdict('refused', 'not-killed').pass, true);
  for (const bad of ['killed', 'error', 'timeout']) assert.equal(verdict(bad, 'not-killed').pass, false);
  assert.throws(() => verdict('loaded', 'whatever'), /--expect must be one of/);
});

test('#10264 cap sizes and phase labels', () => {
  assert.equal(parseSize('3G'), 3 * 2 ** 30);
  assert.equal(parseSize('1536M'), 1536 * 2 ** 20);
  assert.equal(parseSize('1048576'), 2 ** 20);
  assert.throws(() => parseSize('3 GB'), /bad size/);
  assert.equal(phaseOf(null), 'before-open');
  assert.equal(phaseOf({ loading: true, progress: { phase: 'Parsing' }, tris: 0 }), 'pre-geometry (Parsing)');
  assert.equal(phaseOf({ loading: true, tris: 10 }), 'geometry-streaming');
  assert.equal(phaseOf({ interactive: true, tris: 10 }), 'loaded');
});
