/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { invertAppearancePartition, validateAppearancePartition, type AppearancePartition } from './appearance-partition.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };
const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: ({ size }: GPUBufferDescriptor) => { const data = new ArrayBuffer(size); return { size, getMappedRange: () => data, unmap() {}, destroy() {} }; },
  createBindGroup: () => ({}), createSampler: () => ({}),
  createTexture: () => ({ createView: () => ({}), destroy() {} }),
  queue: { writeBuffer() {}, writeTexture() {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}), createTexturedBindGroup: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];

// One flat quad (two triangles) owned by one item, as the loader stamps it.
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
const quad: MeshData = { expressId: 7, geometryItemId: 21, color: [0.8, 0.2, 0.1, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices,
  appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
const split: AppearancePartition = { before: [{ geometryItemId: 21, triangles: [0, 1] }],
  after: [{ geometryItemId: 101, triangles: [0] }, { geometryItemId: 102, triangles: [1] }] };

/** The textured half carries triangle 0 with expanded corners and UVs; the
 * retained half keeps triangle 1 with the source colour, exactly as the
 * viewer binder authors a masked conversion. */
function halves(original: MeshData): [MeshData, MeshData] {
  const corner = (i: number) => [original.positions[original.indices[i] * 3], original.positions[original.indices[i] * 3 + 1], original.positions[original.indices[i] * 3 + 2]];
  const texturedIndices = new Uint32Array([0, 1, 2]);
  const textured: MeshData = { ...original, geometryItemId: 101, color: [1, 1, 1, 1], indices: texturedIndices,
    positions: new Float32Array([...corner(0), ...corner(1), ...corner(2)]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1]), texture: { rgba: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, repeatS: true, repeatT: true },
    appearanceSource: { kind: 'canonical-item', indices: texturedIndices, sourceIndices: texturedIndices } };
  const retainedIndices = new Uint32Array([0, 2, 3]);
  const retained: MeshData = { ...original, geometryItemId: 102, indices: retainedIndices,
    appearanceSource: { kind: 'canonical-item', indices: retainedIndices, sourceIndices: retainedIndices } };
  return [textured, retained];
}

describe('partitioned appearance preview (#4404)', () => {
  function setup() {
    const scene = new Scene();
    scene.appendToBatches([quad], device, pipeline);
    const original = scene.getMeshDataPieces(7)![0];
    return { scene, original, api: scene.appearancePreview(device, pipeline), owner: { expressId: 7, modelIndex: 0 } };
  }
  it('splits one owner part into textured and retained parts, cancels back to one, and records the partition', () => {
    const { scene, original, api, owner } = setup();
    const [textured, retained] = halves(original);
    const token = api.begin(owner, { partition: split });
    api.update(token, [textured, retained]);
    assert.deepEqual(scene.getMeshDataPieces(7)!.map(part => part.geometryItemId), [101, 102]);
    assert.equal(scene.getTexturedMeshes().filter(mesh => mesh.expressId === 7).length, 1);
    assert.deepEqual([...scene.getMeshDataPieces(7)![1].color], [0.8, 0.2, 0.1, 1]);
    api.cancel(token);
    assert.deepEqual(scene.getMeshDataPieces(7)!.map(part => part.geometryItemId), [21]);
    assert.equal(scene.getTexturedMeshes().filter(mesh => mesh.expressId === 7).length, 0);
    const committed = api.begin(owner, { partition: split });
    api.update(committed, [textured, retained]);
    const change = api.commit(committed);
    assert.deepEqual(change.partition, split);
    assert.equal(change.before.length, 1); assert.equal(change.after.length, 2);
    assert.equal(change.geometryItemRemaps, undefined);
    // Undo joins the two parts back into the original through the inverted record.
    const undo = api.begin(owner, { partition: invertAppearancePartition(change.partition!) });
    api.update(undo, [{ ...scene.appearanceSourceMesh(change.before[0]) }]);
    assert.deepEqual(scene.getMeshDataPieces(7)!.map(part => part.geometryItemId), [21]);
    const joined = api.commit(undo);
    assert.deepEqual(joined.partition, invertAppearancePartition(split));
    scene.clear();
  });
  it('refuses a split that renames, moves, duplicates or drops triangles without touching the scene', () => {
    const { scene, original, api, owner } = setup();
    const [textured, retained] = halves(original);
    assert.throws(() => api.begin(owner, { partition: { ...split, before: [{ geometryItemId: 99, triangles: [0, 1] }] } }), /Invalid appearance partition/);
    assert.throws(() => api.begin(owner, { partition: split, geometryItemRemaps: [{ from: 21, to: 31 }] }), /Invalid appearance partition/);
    assert.throws(() => api.begin(owner, { partition: { ...split, after: [{ geometryItemId: 21, triangles: [0, 1] }] } }), /Invalid appearance partition/);
    const token = api.begin(owner, { partition: split });
    assert.throws(() => api.update(token, [textured]), /does not name every part/);
    assert.throws(() => api.update(token, [retained, textured]), /identity does not match/);
    assert.throws(() => api.update(token, [{ ...textured, geometryItemId: 102 }, { ...retained, geometryItemId: 101 }]), /identity does not match/);
    const moved = { ...textured, positions: textured.positions.slice() }; moved.positions[0] = 0.5;
    assert.throws(() => api.update(token, [moved, retained]), /changes triangle geometry/);
    assert.throws(() => api.update(token, [{ ...textured, expressId: 8 }, retained]), /ownership or placement/);
    assert.throws(() => api.update(token, [{ ...textured, origin: [1, 0, 0] }, retained]), /ownership or placement/);
    assert.throws(() => api.update(token, [textured, { ...retained, indices: new Uint32Array([0, 1, 2]) }]), /changes triangle geometry/);
    assert.throws(() => api.update(token, [{ ...textured, uvs: undefined }, retained]), /finite UVs/);
    assert.deepEqual(scene.getMeshDataPieces(7)!.map(part => part.geometryItemId), [21]);
    api.cancel(token);
    scene.clear();
  });
  it('validates coverage on both sides independently of the scene', () => {
    const [textured, retained] = halves(quad);
    validateAppearancePartition(split, [quad], [textured, retained]);
    assert.throws(() => validateAppearancePartition({ ...split, after: [{ geometryItemId: 101, triangles: [0] }, { geometryItemId: 102, triangles: [0] }] },
      [quad], [textured, { ...retained, indices: new Uint32Array([0, 1, 2]) }]), /names a triangle twice/);
    assert.throws(() => validateAppearancePartition({ ...split, before: [{ geometryItemId: 21, triangles: [0, 2] }] }, [quad], [textured, retained]), /changes triangle geometry/);
    assert.throws(() => validateAppearancePartition({ ...split, after: [{ geometryItemId: 101, triangles: [0, 1] }, { geometryItemId: 102, triangles: [1] }] }, [quad], [textured, retained]), /triangle count/);
    assert.throws(() => validateAppearancePartition(split, [quad], [textured, { ...retained, normals: new Float32Array([0, 0, 1]) }]), /normals are invalid/);
  });
});
