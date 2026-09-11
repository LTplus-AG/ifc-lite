/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { splitMeshForStreaming } from './scene-stream-split.js';

describe('captured-object texture loss on streaming split (#4228)', () => {
  it('preserves every triangle corner, UV seam, entity lane and shared texture', () => {
    const mesh: MeshData = {
      expressId: 7, ifcType: 'IfcBuildingElementProxy', color: [1, 1, 1, 1],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([2, 0, 1, 3, 2, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, .5, .5]),
      entityIds: new Uint32Array([7, 8, 9, 10]),
      textureRef: { textureId: 31, url: 'textures/capture.jpg', repeatS: false, repeatT: false },
      textureBitmap: { width: 1, height: 1, close() { throw new Error('Splitting must not close the shared bitmap'); } },
      modelIndex: 2,
      origin: [10, 20, 30], geometryItemId: 29,
    };
    const fragments = splitMeshForStreaming(mesh, 3, 1024);
    assert.equal(fragments.length, 2);
    let corner = 0;
    for (const fragment of fragments) {
      assert.strictEqual(fragment.textureRef, mesh.textureRef);
      assert.strictEqual(fragment.textureBitmap, mesh.textureBitmap);
      assert.equal(fragment.modelIndex, 2);
      assert.strictEqual(fragment.origin, mesh.origin);
      assert.equal(fragment.geometryItemId, 29);
      for (const index of fragment.indices) {
        const source = mesh.indices[corner++];
        assert.deepEqual(fragment.positions.slice(index * 3, index * 3 + 3), mesh.positions.slice(source * 3, source * 3 + 3));
        assert.deepEqual(fragment.uvs!.slice(index * 2, index * 2 + 2), mesh.uvs!.slice(source * 2, source * 2 + 2));
        assert.equal(fragment.entityIds![index], mesh.entityIds![source]);
      }
    }
    assert.equal(corner, mesh.indices.length);
  });
});
