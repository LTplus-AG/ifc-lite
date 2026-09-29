/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { liftNewInstancedOccurrences, placeNewMeshesAtCurrentLevel } from './level-arrival.js';

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [0, 0, 0],
  };
}

describe('late geometry inherits current exploded level offsets (#6417)', () => {
  it('lifts an appended second piece without changing the already-lifted piece', () => {
    const globalId = 1_000_042;
    const alreadyLoaded = { ...mesh(globalId), origin: [0, 2, 0] as [number, number, number] };
    const appendedPiece = mesh(globalId);

    // The stream sends only appended pieces through this helper. Existing
    // renderer geometry already carries its lift and must receive no delta.
    const [arriving] = placeNewMeshesAtCurrentLevel([appendedPiece], new Map([[globalId, 2]]));

    assert.deepEqual(alreadyLoaded.origin, [0, 2, 0], 'the earlier piece stays at its current lift');
    assert.deepEqual(alreadyLoaded.positions, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    assert.notEqual(arriving, appendedPiece, 'the renderer receives a lifted wrapper for the late piece');
    assert.deepEqual(arriving?.origin, [0, 2, 0]);
    assert.deepEqual(appendedPiece.origin, [0, 0, 0], 'source geometry stays at native coordinates');
  });

  it('lifts a newly uploaded instanced occurrence after its ID is globalized', () => {
    const globalId = 1_000_042;
    const transform = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 3,
      0, 0, 0, 1,
    ]);
    const shard: DecodedInstancedShard = {
      templates: [],
      instances: [{ templateIndex: 0, entityId: globalId, color: [1, 1, 1, 1], transform }],
      carriesItemIds: false,
    };

    liftNewInstancedOccurrences(shard, new Map([[globalId, 2]]));

    assert.equal(shard.instances[0].transform[11], 5,
      'IFC Z translation is renderer Y after the Z-up to Y-up conversion');
  });
});
