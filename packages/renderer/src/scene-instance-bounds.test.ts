/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unionInstancedWorldAabb } from './scene-instance-bounds.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import type { BoundingBox } from './scene-raycaster.js';

describe('instanced canonical-anchor bounds (#5049, #6393)', () => {
  const identityRecords = (count: number) => {
    const records = new ArrayBuffer(count * INSTANCE_STRIDE_BYTES);
    const view = new DataView(records);
    for (let i = 0; i < count; i++) {
      for (const axis of [0, 1, 2]) view.setFloat32(i * INSTANCE_STRIDE_BYTES + axis * 20, 1, true);
    }
    return view;
  };

  it('keeps a centimetre box at 5,000 km in the CPU cull broad phase', () => {
    const view = identityRecords(1);
    // The f32 matrix translation has already lost the .125m residual.
    view.setFloat32(48, 5_000_000, true);
    const anchors = new Float64Array([5_000_000.125, -10, 2]);
    const boxes = new Map<number, BoundingBox>();
    const bounds = unionInstancedWorldAabb(boxes, 9, view, 0, anchors, 0, 0, 0, 0.01, 0.01, 0.01);
    assert.equal(bounds.minX, 5_000_000.125);
    assert.equal(bounds.maxX, 5_000_000.135);
    assert.equal(boxes.get(9)?.min.x, 5_000_000.125);
  });

  it('reads each record\'s own f64 anchor at full precision, with no f32 split in between (#6393)', () => {
    // Beyond what an f32 high/low pair can carry: the record no longer holds
    // anchor lanes, so bounds must come straight from the f64 sidecar.
    const view = identityRecords(2);
    const anchors = new Float64Array([0, 0, 0, 6_378_137.123456789, 5_600_000.000000001, -1_234_567.987654321]);
    const boxes = new Map<number, BoundingBox>();
    const bounds = unionInstancedWorldAabb(boxes, 4, view, INSTANCE_STRIDE_BYTES, anchors, 0, 0, 0, 0, 0, 0);
    assert.deepEqual(
      [bounds.minX, bounds.minY, bounds.minZ],
      [6_378_137.123456789, 5_600_000.000000001, -1_234_567.987654321],
    );
  });
});
