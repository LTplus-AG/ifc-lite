// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFrameTimes, sidecarPath, validateVideoTimebase } from './contracts.mjs';

const must = (value, message) => assert.ok(value, message);

test('first frame can precede registration; subsequent frames retain bounds', () => {
  validateFrameTimes([99.5, 133, 166], 100, 170, must);
  for (const times of [[-1, 133], [99, 99.5], [99, 133, 132], [99, 171], [NaN, 133]]) {
    assert.throws(() => validateFrameTimes(times, 100, 170, must));
  }
  assert.throws(() => validateFrameTimes([99], 100, 3101, must));
});

test('#7712: finalizer path requires a string ID and rejects path traversal', () => {
  assert.equal(sidecarPath('/cohort', 2, { id: 'sample-2' }),
    '/cohort/case-02/sample-2.recording-frame-class-reviewed.json');
  assert.throws(() => sidecarPath('/cohort', 2, { id: '../sample' }));
  for (const sample of [undefined, null, {}, { id: undefined }, { id: 123 }, { id: ['abc'] }]) {
    assert.throws(() => sidecarPath('/cohort', 2, sample), /Invalid planned sample index\/id/);
  }
});

test('#7712: all 30 video streams retain the same inspected timebase', () => {
  let expected;
  for (let i = 0; i < 30; i++) {
    expected = validateVideoTimebase('1/15360', '1/15360', expected, must);
  }
  assert.throws(() => validateVideoTimebase('1/30000', '1/30000', expected, must),
    /changed across cohort/);
  assert.throws(() => validateVideoTimebase('1/15360', '1/30000', expected, must),
    /differs from video stream/);
  for (const invalid of [undefined, '', '0/15360', '1/0', 'n/a']) {
    assert.throws(() => validateVideoTimebase(invalid, invalid, undefined, must),
      /Missing\/invalid/);
  }
});
