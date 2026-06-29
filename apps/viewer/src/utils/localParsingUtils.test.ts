/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { calculateMeshBounds } from './localParsingUtils.js';

function mesh(origin?: [number, number, number]): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([-15, -15, -15, 2, 1, 14]),
    normals: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ...(origin ? { origin } : {}),
  };
}

describe('calculateMeshBounds — per-element origin folding', () => {
  // Regression for the Codex P1 on #1446: a translated GLB re-imports as local
  // positions + a (possibly georeferenced ~1e6 m) origin. The bounds feed
  // coordinateInfo.shiftedBounds, which useGeometryStreaming uses as a camera-fit
  // fallback — so they must be WORLD-space or the camera frames the scene origin.
  it('folds a large georeferenced origin into world-space bounds', () => {
    const { bounds } = calculateMeshBounds([mesh([501018.5, 53, -6083869.3])]);
    // Local x∈[-15,2] → world x∈[~501003, ~501020]; local z∈[-15,14] → world z≈-6.08e6.
    assert.ok(bounds.min.x > 500000 && bounds.max.x > 500000, 'x folded to world');
    assert.ok(bounds.min.z < -6_000_000 && bounds.max.z < -6_000_000, 'z folded to world');
  });

  it('leaves non-local-frame meshes (no origin) at local bounds — no regression', () => {
    const { bounds } = calculateMeshBounds([mesh(undefined)]);
    assert.deepEqual(bounds.min, { x: -15, y: -15, z: -15 });
    assert.deepEqual(bounds.max, { x: 2, y: 1, z: 14 });
  });

  it('still drops corrupted/unshifted local vertices beyond the 10 km guard', () => {
    const m: MeshData = {
      expressId: 2,
      // first vertex is a corrupt 1e7 local stray; the others are sane.
      positions: new Float32Array([1e7, 0, 0, 1, 0, 0, 0, 2, 0]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      origin: [100, 0, 0],
    };
    const { bounds } = calculateMeshBounds([m]);
    // The 1e7 stray is filtered; remaining locals [1,0,0]/[0,2,0] fold the +100 origin.
    assert.equal(bounds.min.x, 100);
    assert.equal(bounds.max.x, 101);
    assert.equal(bounds.max.y, 2);
  });
});
