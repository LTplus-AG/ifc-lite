/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { TriangleCounts } from './triangle-counts';

it('counts split and merged indexed faces under their original objects (#10370)', () => {
  const counts = new TriangleCounts();
  const triangle = new Uint32Array([0, 1, 2]);
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 999, indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    entityIds: new Uint32Array([7, 7, 7, 8, 8, 8]) });
  assert.equal(counts.byEntity.get(7), 3);
  assert.equal(counts.byEntity.get(8), 1);
  assert.equal(counts.byEntity.has(999), false);
  assert.equal(counts.total, 4);
});

it('counts each template occurrence and combines flat and instanced pieces (#10370)', () => {
  const counts = new TriangleCounts();
  const template = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), origin: [0, 0, 0] as [number, number, number] };
  const occurrence = (entityId: number) => ({ entityId, templateIndex: 0,
    color: [1, 1, 1, 1] as [number, number, number, number], transform: new Float32Array(16) });
  counts.addInstancedShard({ templates: [template], instances: [occurrence(7), occurrence(8), occurrence(8)] });
  counts.addMesh({ expressId: 7, indices: template.indices });
  assert.equal(counts.byEntity.get(7), 2);
  assert.equal(counts.byEntity.get(8), 2);
  assert.equal(counts.total, 4, 'one template used three times contributes three faces');
});
