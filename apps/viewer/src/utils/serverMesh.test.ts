/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertServerMesh } from './serverMesh.js';
import type { MeshData as ServerMeshData } from '@ifc-lite/server-client';

/**
 * Contract test for issue #1841: the server→viewer mesh conversion MUST carry
 * the canonical `origin` / `geometryClass` through. Dropping either is exactly
 * what collapsed origin-relative / instanced geometry onto the world origin.
 */

const base: ServerMeshData = {
  express_id: 42,
  ifc_type: 'IfcSlab',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  color: [0.5, 0.5, 0.5, 1],
};

test('forwards per-mesh origin (placement) into the canonical MeshData', () => {
  const out = convertServerMesh({ ...base, origin: [10, 3, -20] });
  assert.deepEqual(out.origin, [10, 3, -20]);
  assert.equal(out.expressId, 42);
  assert.equal(out.ifcType, 'IfcSlab');
});

test('forwards geometry_class (so instanced type templates can be filtered)', () => {
  const out = convertServerMesh({ ...base, geometry_class: 2 });
  assert.equal(out.geometryClass, 2);
});

test('omits origin / geometryClass when absent (world-baked meshes stay bare)', () => {
  const out = convertServerMesh(base);
  assert.equal('origin' in out, false);
  assert.equal('geometryClass' in out, false);
});
