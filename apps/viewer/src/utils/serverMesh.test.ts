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

test('omits an all-zero origin so every transport decodes to the same shape', () => {
  const out = convertServerMesh({ ...base, origin: [0, 0, 0], geometry_class: 0 });
  assert.equal('origin' in out, false);
  assert.equal('geometryClass' in out, false);
});

test('keeps an origin that is zero on only some axes', () => {
  const out = convertServerMesh({ ...base, origin: [0, 0, -20] });
  assert.deepEqual(out.origin, [0, 0, -20]);
});

test('forwards the representation-item id, so a REST-loaded pick can reach source (#3199)', () => {
  const out = convertServerMesh({ ...base, geometry_item_id: 1234 });
  assert.equal(out.geometryItemId, 1234);
  assert.equal('materialId' in out, false);
});

test('forwards the material id, disjoint from the representation-item id (#3199)', () => {
  const out = convertServerMesh({ ...base, material_id: 3876 });
  assert.equal(out.materialId, 3876);
  assert.equal('geometryItemId' in out, false);
});

test('omits both source ids when the server sent neither', () => {
  const out = convertServerMesh(base);
  assert.equal('geometryItemId' in out, false);
  assert.equal('materialId' in out, false);
});

// The other two optionals in this converter are truthiness-gated on purpose: a
// zero origin and class 0 are both the default, so carrying them would make the
// same mesh decode differently per transport. A source id is not like that --
// it is an express instance name, and this converter must not invent a rule
// about which values are "real". The server already drops 0 (`#0` is not an
// entity), so if one ever arrives the honest thing is to pass it through and
// let the id-provenance tests catch it, not to silently swallow it here.
test('does not truthiness-gate the source ids the way it gates origin and class', () => {
  const out = convertServerMesh({ ...base, geometry_item_id: 0 });
  assert.equal(out.geometryItemId, 0, 'a 0 id was dropped by a truthiness check');
});
