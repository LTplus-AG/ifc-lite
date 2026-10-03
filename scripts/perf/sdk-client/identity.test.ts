/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537: CPU-output identity invariants, not proof of real model eligibility.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeshData, StreamingGeometryEvent } from '@ifc-lite/geometry';
import { identity } from './identity.js';
import { Retention } from './retention.js';
import { bounds, type Complete } from './contracts.js';

function complete(totalMeshes: number): Complete {
  const min = { x: 0, y: 0, z: 0 }, max = { x: 1, y: 1, z: 1 };
  return { type: 'complete', totalMeshes, coordinateInfo: { originShift: min,
    originalBounds: { min, max }, shiftedBounds: { min, max }, hasLargeCoordinates: false } };
}
function mesh(id = 1): MeshData {
  return { expressId: id, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.6, 0.7, 1], origin: [0, 0, 0] };
}
function batch(meshes: MeshData[], shards?: ArrayBuffer[]): StreamingGeometryEvent {
  return { type: 'batch', meshes, totalSoFar: meshes.length, instancedShards: shards };
}
function flatHash(meshes: MeshData[]) { return identity([batch(meshes)], complete(meshes.length)); }

// Actual IFNS wire contract: 8 u32 header, 48B templates with f64 origins,
// 100B occurrences, pooled f32 positions/normals and u32 indices. No bit casts.
function shard(templateOrder = [0, 1], occurrenceTemplates = [0, 1], origin = 0,
  translation = 0, itemId = 10, metallic = 0.2,
  normalMode: 'full' | 'empty' | 'partial' | 'full-zero' = 'full'): ArrayBuffer {
  const templates = templateOrder.length, instances = occurrenceTemplates.length;
  const normalLength = normalMode === 'empty' ? 0 : normalMode === 'partial' ? 3 : 9;
  const instanceOffset = 32 + templates * 48;
  const dataOffset = instanceOffset + instances * 100;
  const buffer = new ArrayBuffer(dataOffset + templates * (9 + normalLength + 3) * 4);
  const view = new DataView(buffer);
  [0x49464e53, 3, templates, instances, templates * 9, templates * normalLength, templates * 3, 100]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  for (let index = 0; index < templates; index++) {
    const offset = 32 + index * 48;
    [index * 9, 9, index * normalLength, normalLength, index * 3, 3]
      .forEach((value, field) => view.setUint32(offset + field * 4, value, true));
    view.setFloat64(offset + 24, origin, true);
    const geometry = mesh();
    geometry.positions[0] = templateOrder[index];
    for (let vertex = 0; vertex < 9; vertex++) {
      view.setFloat32(dataOffset + (index * 9 + vertex) * 4, geometry.positions[vertex], true);
      if (vertex < normalLength) view.setFloat32(dataOffset + (templates * 9 + index * normalLength + vertex) * 4,
        normalMode === 'full-zero' ? 0 : geometry.normals[vertex], true);
    }
    for (let vertex = 0; vertex < 3; vertex++) {
      view.setUint32(dataOffset + (templates * (9 + normalLength) + index * 3 + vertex) * 4, vertex, true);
    }
  }
  for (let index = 0; index < instances; index++) {
    const offset = instanceOffset + index * 100;
    view.setUint32(offset, templateOrder.indexOf(occurrenceTemplates[index]), true);
    view.setUint32(offset + 4, 1, true);
    [0.5, 0.6, 0.7, 1].forEach((value, component) => view.setFloat32(offset + 8 + component * 4, value, true));
    for (let component = 0; component < 16; component++) {
      view.setFloat32(offset + 24 + component * 4, component === 3 ? translation : component % 5 === 0 ? 1 : 0, true);
    }
    view.setUint32(offset + 88, itemId, true);
    view.setFloat32(offset + 92, metallic, true);
    view.setFloat32(offset + 96, 0.8, true);
  }
  return buffer;
}
function instanceHash(value: ArrayBuffer, count = 2) {
  return identity([batch([], [value])], complete(count));
}

test('#6537 flat arrival order does not change identity', async () => {
  assert.equal((await flatHash([mesh(1), mesh(2)])).sha256, (await flatHash([mesh(2), mesh(1)])).sha256);
});
test('#6537 actual normal bytes change identity', async () => {
  const changed = mesh(); changed.normals[0] = Math.fround(2 ** -24);
  assert.notEqual((await flatHash([mesh()])).sha256, (await flatHash([changed])).sha256);
});
test('#6537 f64 flat origins are not flattened to float32', async () => {
  const changed = mesh(); changed.origin = [1 + 2 ** -40, 0, 0];
  const original = mesh(); original.origin = [1, 0, 0];
  assert.notEqual((await flatHash([original])).sha256, (await flatHash([changed])).sha256);
});
test('#6537 final color updates are part of identity', async () => {
  const event: StreamingGeometryEvent = { type: 'colorUpdate', updates: new Map([[1, [1, 0, 0, 1]]]) };
  assert.notEqual((await flatHash([mesh()])).sha256, (await identity([batch([mesh()]), event], complete(1))).sha256);
});
test('#6537 UV output is a terminal identity refusal', async () => {
  const value = mesh(); value.uvs = new Float32Array(6);
  await assert.rejects(flatHash([value]), /unsupported flat output channel: uvs/);
});
test('#6537 unknown IFNS version refuses before permissive decoder', async () => {
  const value = shard(); new DataView(value).setUint32(4, 4, true);
  await assert.rejects(instanceHash(value), /unknown IFNS/);
});
test('#6537 unknown IFNS stride refuses before permissive decoder', async () => {
  const value = shard(); new DataView(value).setUint32(28, 104, true);
  await assert.rejects(instanceHash(value), /unknown IFNS/);
});
test('#6537 trailing IFNS bytes refuse', async () => {
  const value = shard(); const padded = new Uint8Array(value.byteLength + 4); padded.set(new Uint8Array(value));
  await assert.rejects(instanceHash(padded.buffer), /unowned IFNS/);
});
test('#6537 huge IFNS count refuses before allocation', async () => {
  const value = shard(); new DataView(value).setUint32(12, bounds.identities + 1, true);
  await assert.rejects(instanceHash(value), /allocation bound/);
});
test('#6537 duplicate occurrence multiplicity changes identity', async () => {
  const twice = await instanceHash(shard([0], [0, 0]), 2);
  const once = await instanceHash(shard([0], [0]), 1);
  assert.equal(twice.occurrences, 2); assert.notEqual(twice.sha256, once.sha256);
});
test('#6537 template order does not change occurrence identity', async () => {
  assert.equal((await instanceHash(shard([0, 1]))).sha256, (await instanceHash(shard([1, 0]))).sha256);
});
test('#6537 f64 template origin differences survive decoder and hash', async () => {
  assert.notEqual((await instanceHash(shard([0, 1], [0, 1], 1))).sha256,
    (await instanceHash(shard([0, 1], [0, 1], 1 + 2 ** -40))).sha256);
});
test('#6537 float32 transform signed zero survives decoder and hash', async () => {
  assert.notEqual((await instanceHash(shard([0, 1], [0, 1], 0, 0))).sha256,
    (await instanceHash(shard([0, 1], [0, 1], 0, -0))).sha256);
});
test('#6537 occurrence representation item ID changes identity', async () => {
  assert.notEqual((await instanceHash(shard([0, 1], [0, 1], 0, 0, 10))).sha256,
    (await instanceHash(shard([0, 1], [0, 1], 0, 0, 11))).sha256);
});
test('#6537 occurrence finish changes identity', async () => {
  assert.notEqual((await instanceHash(shard([0, 1], [0, 1], 0, 0, 10, 0.2))).sha256,
    (await instanceHash(shard([0, 1], [0, 1], 0, 0, 10, 0.3))).sha256);
});
test('#6537 complete census mismatches refuse', async () => {
  await assert.rejects(identity([batch([mesh()])], complete(2)), /census mismatch/);
});
test('#6537 retention counts full backing bytes once across disjoint views', () => {
  const backing = new ArrayBuffer(128); const retained = new Retention();
  retained.add({ a: new Float32Array(backing, 0, 4), b: new Uint32Array(backing, 64, 4) });
  assert.equal(retained.bytes, 128); assert.equal(retained.bufferCount, 1);
});

// Real default Haus #6537: IfcMember36411 has Float32 positions72, normals0,
// Uint32 indices36. This supported omission must not be filled during identity.
test('#6537 canonical empty flat normals accepted and distinct from full zero normals', async () => {
  const empty = mesh(); empty.normals = new Float32Array(0);
  const zeros = mesh(); zeros.normals = new Float32Array(zeros.positions.length);
  const accepted = await flatHash([empty]);
  assert.equal(accepted.flat, 1);
  assert.notEqual(accepted.sha256, (await flatHash([zeros])).sha256);
});
test('#6537 nonzero partial flat normal arrays remain refused', async () => {
  const partial = mesh(); partial.normals = new Float32Array(3);
  await assert.rejects(flatHash([partial]), /unsupported flat geometry shape/);
});
test('#6537 canonical empty template normals accepted and distinct from full zero normals', async () => {
  const empty = await instanceHash(shard([0, 1], [0, 1], 0, 0, 10, 0.2, 'empty'));
  const zeros = await instanceHash(shard([0, 1], [0, 1], 0, 0, 10, 0.2, 'full-zero'));
  assert.equal(empty.occurrences, 2);
  assert.notEqual(empty.sha256, zeros.sha256);
});
test('#6537 nonzero partial template normal arrays remain refused', async () => {
  await assert.rejects(instanceHash(shard([0, 1], [0, 1], 0, 0, 10, 0.2, 'partial')),
    /unsupported instance template shape/);
});
