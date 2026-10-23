/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6709 / review r4364882082: missing width must not certify DPR1 quality.
import assert from 'node:assert/strict';
import { fullQuality, requireDimensions } from './frame-dimensions.mts';

let refused = 0;
for (const dpr of [1, 2]) {
  const valid = { width: 1440 * dpr, height: 900 * dpr, cssWidth: 1440, cssHeight: 900 };
  fullQuality(valid, dpr);
  fullQuality({ width: Math.round(1440.25 * dpr), height: Math.round(900.25 * dpr), cssWidth: 1440.25, cssHeight: 900.25 }, dpr);
  for (const field of ['width', 'height', 'cssWidth', 'cssHeight']) {
    for (const invalid of [undefined, null, NaN, Infinity, -Infinity, 0, -1, '1440']) {
      const observed = { ...valid, [field]: invalid };
      assert.throws(() => fullQuality(observed, dpr));
      assert.throws(() => requireDimensions(observed));
      refused++;
    }
    const absent: Record<string, number> = { ...valid };
    delete absent[field];
    assert.throws(() => fullQuality(absent, dpr));
    refused++;
  }
  for (const field of ['width', 'height']) {
    assert.throws(() => fullQuality({ ...valid, [field]: valid[field as 'width' | 'height'] + 3 }, dpr));
    refused++;
  }
}
for (const invalid of [undefined, null, NaN, Infinity, -Infinity, 0, -1, '1']) {
  assert.throws(() => fullQuality({ width: 1440, height: 900, cssWidth: 1440, cssHeight: 900 }, invalid));
  refused++;
}
assert.throws(() => requireDimensions(undefined));
assert.throws(() => requireDimensions(null));
console.log(JSON.stringify({ ok: true, refusedCases: refused + 2, scope: 'Dimension guard diagnostic; no native timing or viewer correctness claim' }));
