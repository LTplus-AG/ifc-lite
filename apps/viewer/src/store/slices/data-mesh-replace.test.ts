/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `replaceEntityMeshesPatch` (#6232 WP1): one store update that swaps an
 * entity's meshes for re-meshed ones, keeping every mesh that also hosts
 * another entity, the model's totals, and its pre-alignment snapshot by index.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel, PreAlignmentSnapshot } from '../types.js';
import { replaceEntityMeshesPatch, type ReplaceMeshesState } from './data-mesh-replace.js';

function mesh(expressId: number, x: number, entityIds?: number[]): MeshData {
  return {
    expressId, ifcType: 'IfcWall',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
    ...(entityIds ? { entityIds: new Uint32Array(entityIds) } : {}),
  } as MeshData;
}

function state(meshes: MeshData[], preAlignment?: PreAlignmentSnapshot): ReplaceMeshesState {
  const geometry = { meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3, coordinateInfo: {} } as unknown as GeometryResult;
  const model = { id: 'm', geometryResult: geometry, preAlignment } as unknown as FederatedModel;
  return { activeModelId: 'm', models: new Map([['m', model]]), geometryResult: geometry, geometryUpdateTick: 10, pendingMeshEdits: null };
}

describe('replaceEntityMeshesPatch (#6232)', () => {
  it('swaps a dedicated mesh, keeps a colour-merged one hosting another entity, and queues the edit', () => {
    const own = mesh(1, 0);
    const merged = mesh(1, 5, [1, 1, 1, 2, 2, 2]);
    const other = mesh(3, 9);
    const replacement = mesh(1, 20);
    const patch = replaceEntityMeshesPatch(state([own, merged, other]), 'm', new Map([[1, [replacement]]]));
    const geometry = patch.models!.get('m')!.geometryResult!;
    assert.deepEqual(geometry.meshes, [merged, other, replacement]);
    assert.equal(geometry.totalTriangles, 3);
    assert.equal(patch.geometryResult, geometry, 'the active mirror follows');
    assert.deepEqual([...patch.pendingMeshEdits!.ids], [1]);
    assert.equal(patch.pendingMeshEdits!.tick, patch.geometryUpdateTick);
  });

  it('an empty replacement removes the entity', () => {
    const patch = replaceEntityMeshesPatch(state([mesh(1, 0), mesh(3, 9)]), 'm', new Map([[1, []]]));
    assert.deepEqual(patch.models!.get('m')!.geometryResult!.meshes.map((m) => m.expressId), [3]);
  });

  it('keeps the pre-alignment snapshot aligned by index, using the pre-alignment copies it is given', () => {
    const snapshot = {
      positions: [new Float32Array([1]), new Float32Array([3])], normals: [undefined, undefined],
      origins: [undefined, undefined], geometryAabbs: [undefined, undefined], coordinateInfo: {},
    } as unknown as PreAlignmentSnapshot;
    const aligned = mesh(1, 100);
    const pristine = { positions: new Float32Array([42]) };
    const patch = replaceEntityMeshesPatch(state([mesh(1, 0), mesh(3, 9)], snapshot), 'm', new Map([[1, [aligned]]]), new Map([[1, [pristine]]]));
    const next = patch.models!.get('m')!.preAlignment!;
    assert.deepEqual(next.positions.map((p) => [...p]), [[3], [42]], "entity 3's slot kept; the new mesh's slot is its pre-alignment copy");
  });
});
