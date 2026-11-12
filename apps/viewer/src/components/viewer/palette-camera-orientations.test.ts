/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE_CAMERA_ORIENTATIONS } from './palette-camera-orientations';

test('#8947 palette covers all twelve cube edges and eight corners without duplicating six face commands', () => {
  const expected = new Set<string>();
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) >= 2) expected.add(`${x},${y},${z}`);
  }
  assert.equal(PALETTE_CAMERA_ORIENTATIONS.length, 20);
  assert.deepEqual(new Set(PALETTE_CAMERA_ORIENTATIONS.map(p => p.key)), expected);
  assert.equal(PALETTE_CAMERA_ORIENTATIONS.filter(p => p.kind === 'edge').length, 12);
  assert.equal(PALETTE_CAMERA_ORIENTATIONS.filter(p => p.kind === 'corner').length, 8);
  for (const preset of PALETTE_CAMERA_ORIENTATIONS) {
    assert.equal(preset.faces.length, preset.kind === 'edge' ? 2 : 3);
    assert.equal(new Set(preset.faces).size, preset.faces.length);
  }
});
