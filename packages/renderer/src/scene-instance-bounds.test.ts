/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unionInstancedWorldAabb } from './scene-instance-bounds.js';

describe('instanced canonical-anchor bounds (#5049)', () => {
  it('keeps a centimetre box at 5,000 km in the CPU cull broad phase', () => {
    const record = new ArrayBuffer(120);
    const view = new DataView(record);
    for (const axis of [0, 1, 2]) view.setFloat32(axis * 20, 1, true);
    // The legacy V1 matrix has already lost the .125m residual.
    view.setFloat32(48, 5_000_000, true);
    const origin = [5_000_000.125, -10, 2] as const;
    for (const axis of [0, 1, 2]) {
      const high = Math.fround(origin[axis]);
      view.setFloat32(88 + axis * 4, high, true);
      view.setFloat32(104 + axis * 4, Math.fround(origin[axis] - high), true);
    }
    const boxes = new Map();
    const bounds = unionInstancedWorldAabb(boxes, 9, view, 0, 0, 0, 0, 0.01, 0.01, 0.01);
    assert.equal(bounds.minX, 5_000_000.125);
    assert.equal(bounds.maxX, 5_000_000.135);
    assert.equal(boxes.get(9)?.min.x, 5_000_000.125);
  });
});
