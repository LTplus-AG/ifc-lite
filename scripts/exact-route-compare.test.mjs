/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare } from './exact-route-compare.mjs';

import { captureFixture as fixture } from './lib/exact-route-fixture.mjs';
import { INSTANCE, MESH_INSTANCE } from './exact-route-schema.mjs';
// Invariant: bits, metadata, array order and multiplicity are compatibility data.
test('identical ordered scene matches; keyed object order and wall clocks are irrelevant', () => {
  const a = fixture(), b = fixture();
  b.scene.metadata = Object.fromEntries(Object.entries(b.scene.metadata).reverse());
  b.execution_only.total_time_ms = 'u64:999';
  assert.equal(compare(a, b).equal, true);
});
const mutations = {
  position: b => b.scene.meshes[0].serialized.positions[0] = 'f32:00000001',
  negativeZero: b => b.scene.meshes[0].serialized.positions[0] = 'f32:80000000',
  normal: b => b.scene.meshes[0].serialized.normals[0] = 'f32:3f800001',
  index: b => b.scene.meshes[0].serialized.indices[0] = 'u32:1',
  uv: b => b.scene.meshes[0].serialized.uvs[0] = 'f32:00000001',
  color: b => b.scene.meshes[0].serialized.color[0] = 'f32:3f800001',
  textureByte: b => b.scene.meshes[0].serialized.texture.rgba[0] = 'u8:254',
  origin: b => b.scene.meshes[0].origin[0] = 'f64:8000000000000000',
  bounds: b => b.scene.meshes[0].local_bounds[0] = 'f32:00000001',
  transform: b => b.scene.meshes[0].local_to_world[0] = 'f64:3ff0000000000001',
  instanceIdentity: b => b.scene.meshes[0][MESH_INSTANCE][3] = 'u128:340282366920938463463374607431768211454',
  frame: b => b.scene.frame_variant_anchor_placement[0] = 'ModelRtc',
  metadata: b => b.scene.metadata.schema_version = 'IFC2X3',
  omittedField: b => delete b.scene.meshes[0].serialized.uvs,
  duplicateLoss: b => b.scene[INSTANCE].pop(),
  occurrenceOrder: b => b.scene[INSTANCE].reverse().splice(0, 2, b.scene[INSTANCE][1], b.scene[INSTANCE][0]),
  refusal: b => b.scene.stats.refused_input_elements = 'u64:1',
  csgLoss: b => b.scene.stats.total_csg_failures = 'u64:1',
  fixture: b => b.fixture_sha256 = 'other',
  options: b => b.options = 'alternate',
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`mutation-negative: ${name}`, () => {
    const a = fixture(), b = fixture(); mutate(b);
    assert.throws(() => assert.equal(compare(a, b).equal, true));
  });
}
for (const bits of ['f32:7f800000', 'f32:7fc00000', 'f64:fff0000000000000', 'f64:bad']) {
  test(`reject nonfinite/malformed capture ${bits}`, () => {
    const b = fixture(); b.scene.meshes[0].origin[0] = bits;
    assert.throws(() => compare(fixture(), b));
  });
}
test('missing or empty captures never qualify', () => {
  assert.throws(() => compare({}, {}));
  const b = fixture(); b.scene.meshes = [];
  assert.throws(() => compare(fixture(), b));
});

for (const [name, mutate] of Object.entries({
  skeletal: v => v.scene.meshes = [{}],
  positions: v => v.scene.meshes[0].serialized.positions.pop(),
  normals: v => v.scene.meshes[0].serialized.normals = [],
  uvLength: v => v.scene.meshes[0].serialized.uvs.pop(),
  rgbaLength: v => v.scene.meshes[0].serialized.texture.rgba.pop(),
  missingNullableUV: v => delete v.scene.meshes[0].serialized.uvs,
  missingInstance: v => delete v.scene.meshes[0][MESH_INSTANCE],
  frameLength: v => v.scene.frame_world_matrix.pop(),
  frameVariant: v => v.scene.frame_variant_anchor_placement = ['ModelRtc', null, null],
  metadata: v => v.scene.metadata = {},
  metadataType: v => v.scene.metadata.entity_count = 3,
  stats: v => delete v.scene.stats.refused_input_elements,
  options: v => v.options = 'paired alternate',
  nonfinite: v => v.scene.meshes[0].serialized.positions[0] = 'f32:7f800000',
})) {
  test(`paired-identical malformed/truncated capture refuses: ${name}`, () => {
    const a = fixture(); mutate(a); assert.throws(() => compare(a, structuredClone(a)));
  });
}
