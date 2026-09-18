/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import type { PreAlignmentSnapshot } from '../types.js';
import { correctPreAlignmentTail, growPreAlignment, type PreAlignmentMeshBaseline } from './data-mesh-prealign.js';

function coordinateInfo(): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  };
}

function emptySnapshot(): PreAlignmentSnapshot {
  return {
    positions: [], normals: [], origins: [], geometryAabbs: [],
    coordinateInfo: coordinateInfo(),
    instancedGeometryAabbs: undefined,
  };
}

function mesh(expressId: number, positions: number[], origin?: [number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    geometryHash: 1n,
    ...(origin ? { origin } : {}),
  } as MeshData;
}

describe('growPreAlignment (#4970)', () => {
  it('appends one index-aligned entry per mesh, own copies not shared references', () => {
    const m = mesh(1, [1, 2, 3], [4, 5, 6]);
    const grown = growPreAlignment(emptySnapshot(), [m]);

    assert.equal(grown.positions.length, 1);
    assert.deepEqual([...grown.positions[0]], [1, 2, 3]);
    assert.deepEqual(grown.origins[0], [4, 5, 6]);
    assert.notEqual(grown.positions[0], m.positions, 'must be a copy, not the live array');

    m.positions[0] = 999;
    assert.equal(grown.positions[0][0], 1, 'editing the live mesh afterward must not rewrite the baseline');
  });

  it('is a no-op on an empty append (identity, not a copy)', () => {
    const snapshot = emptySnapshot();
    assert.equal(growPreAlignment(snapshot, []), snapshot);
  });

  it('grows onto a non-empty snapshot without disturbing existing entries', () => {
    const existing = growPreAlignment(emptySnapshot(), [mesh(1, [1, 1, 1])]);
    const grown = growPreAlignment(existing, [mesh(2, [2, 2, 2]), mesh(3, [3, 3, 3])]);

    assert.equal(grown.positions.length, 3);
    assert.deepEqual([...grown.positions[0]], [1, 1, 1]);
    assert.deepEqual([...grown.positions[1]], [2, 2, 2]);
    assert.deepEqual([...grown.positions[2]], [3, 3, 3]);
  });
});

describe('correctPreAlignmentTail (#4970)', () => {
  it('overwrites only the last `count` slots, leaving earlier ones untouched', () => {
    const grown = growPreAlignment(emptySnapshot(), [
      mesh(1, [1, 1, 1]),
      mesh(2, [999, 999, 999]), // wrong: what growPreAlignment naively guessed
      mesh(3, [999, 999, 999]),
    ]);
    const known: (PreAlignmentMeshBaseline | undefined)[] = [
      { positions: new Float32Array([2, 2, 2]), origin: [20, 0, 0] },
      { positions: new Float32Array([3, 3, 3]) },
    ];

    const corrected = correctPreAlignmentTail(grown, 2, known);

    assert.deepEqual([...corrected.positions[0]], [1, 1, 1], 'slot 0 (not part of the tail) must be untouched');
    assert.deepEqual([...corrected.positions[1]], [2, 2, 2]);
    assert.deepEqual(corrected.origins[1], [20, 0, 0]);
    assert.deepEqual([...corrected.positions[2]], [3, 3, 3]);
    assert.equal(corrected.origins[2], undefined);
  });

  it('leaves a slot exactly as grown when its `known` entry is undefined', () => {
    const grown = growPreAlignment(emptySnapshot(), [mesh(1, [7, 7, 7])]);
    const corrected = correctPreAlignmentTail(grown, 1, [undefined]);
    assert.deepEqual([...corrected.positions[0]], [7, 7, 7]);
  });

  it('is a no-op when count is 0 or exceeds the snapshot (identity, not a copy)', () => {
    const grown = growPreAlignment(emptySnapshot(), [mesh(1, [1, 1, 1])]);
    assert.equal(correctPreAlignmentTail(grown, 0, []), grown);
    assert.equal(correctPreAlignmentTail(grown, 5, [undefined, undefined, undefined, undefined, undefined]), grown);
  });

  it('deep-copies the known baseline, not the live reference', () => {
    const grown = growPreAlignment(emptySnapshot(), [mesh(1, [0, 0, 0])]);
    const sourcePositions = new Float32Array([5, 5, 5]);
    const corrected = correctPreAlignmentTail(grown, 1, [{ positions: sourcePositions }]);

    sourcePositions[0] = -1;
    assert.equal(corrected.positions[0][0], 5, 'editing the source array afterward must not rewrite the baseline');
  });
});
