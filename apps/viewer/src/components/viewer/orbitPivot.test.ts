/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClashResult } from '@ifc-lite/clash';
import { focusedClashOrbitPivot } from './orbitPivot.js';

const clashResult = {
  clashes: [{ id: 'c1', bounds: { min: [0, 2, 4], max: [2, 6, 8] } }],
} as unknown as ClashResult;

test('a focused clash with nothing selected pivots at the overlap centre (#4806)', () => {
  assert.deepEqual(
    focusedClashOrbitPivot({ clashSelectedId: 'c1', clashResult }, null),
    { x: 1, y: 4, z: 6 },
  );
});

test('a selection made while a clash stays focused wins on every input path (#4806)', () => {
  // Touch used to ignore the selection and keep orbiting the clash.
  assert.equal(focusedClashOrbitPivot({ clashSelectedId: 'c1', clashResult }, 42), null);
  assert.equal(focusedClashOrbitPivot({ clashSelectedId: 'c1', clashResult }, 0), null);
});

test('no focused clash yields no clash pivot', () => {
  assert.equal(focusedClashOrbitPivot({ clashSelectedId: null, clashResult }, null), null);
  assert.equal(focusedClashOrbitPivot({ clashSelectedId: 'missing', clashResult }, null), null);
});
