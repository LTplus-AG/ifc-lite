/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderFrameWorldOffset } from '@ifc-lite/geometry/world-frame';
import { serverOriginShift } from './serverOriginShift.js';

describe('serverOriginShift (#7734)', () => {
  it("turns the server's Z-up shift into the Y-up CoordinateInfo.originShift", () => {
    // 2,600,000 m east, 1,200,000 m north, 500 m up (IFC Z-up).
    const originShift = serverOriginShift([2_600_000, 1_200_000, 500]);
    assert.deepEqual(originShift, { x: 2_600_000, y: 500, z: -1_200_000 });
    // And it round-trips to the same IFC world offset the exporters add back.
    assert.deepEqual(renderFrameWorldOffset({ originShift }), { x: 2_600_000, y: 1_200_000, z: 500 });
  });

  it('is zero when the server sent no shift', () => {
    assert.deepEqual(serverOriginShift(undefined), { x: 0, y: 0, z: 0 });
  });
});
