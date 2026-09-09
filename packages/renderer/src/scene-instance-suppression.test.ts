/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { INSTANCE_COLOR_OFFSET, INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_SELECTED, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 };

function fixture(modelIndex = 3) {
  const buffers = new WeakMap<GPUBuffer, ArrayBuffer>();
  let failNext = false;
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      buffers.set(buffer, data); return buffer;
    },
    queue: { writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
      if (failNext) { failNext = false; throw new Error('simulated GPU upload failure'); }
      new Uint8Array(buffers.get(buffer)!, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } },
  } as unknown as GPUDevice;
  const shard: DecodedInstancedShard = {
    carriesItemIds: false,
    templates: [{ positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]),
      normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: new Uint32Array([0, 1, 2]), origin: [0, 0, 0] }],
    instances: [41, 42].map((entityId, index) => ({ templateIndex: 0, entityId,
      color: [0.4, 0.5, 0.6, 1], transform: new Float32Array([1, 0, 0, index * 5, 0, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 1]) })),
  };
  const scene = new Scene(); scene.addInstancedShard(device, shard, modelIndex);
  const gpu = scene.getInstancedTemplates()[0];
  const flags = (index: number) => new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(index * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);
  const color = (index: number) => Array.from(new Float32Array(buffers.get(gpu.instanceBuffer)!, index * INSTANCE_STRIDE_BYTES + INSTANCE_COLOR_OFFSET, 4));
  return { scene, gpu, flags, color, fail: () => { failNext = true; } };
}

describe('occurrence appearance resource lifetime (#4404)', () => {
  it('suppresses only the retained occurrence through selection and hide/isolate updates', () => {
    const { scene, gpu, flags, color } = fixture();
    const sibling = scene.getInstancedMeshDataPieces(42)![0];
    scene.setInstancedSelection(new Set([41]));
    const lease = scene.retainInstancedOccurrence(41, 3);
    assert.throws(() => scene.retainInstancedOccurrence(41, 3), /already retains/);
    lease.setSuppressed(true);
    assert.equal(flags(0), INSTANCE_FLAG_SELECTED | INSTANCE_FLAG_HIDDEN);
    assert.equal(flags(1), 0);
    assert.equal(gpu.selectedCount, 1);
    assert.deepEqual([...scene.getInstancedEntityIds()], [42]);
    assert.equal(scene.getInstancedMeshDataPieces(41), undefined);
    assert.deepEqual(scene.getAllInstancedMeshData().map(p => p.expressId), [42]);
    assert.equal(scene.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }), null);
    scene.setInstancedVisibility(null, new Set([41]));
    scene.setInstancedSelection(new Set([42]));
    scene.setInstancedVisibility(null, null);
    assert.equal(flags(0), INSTANCE_FLAG_HIDDEN);
    assert.equal(flags(1), INSTANCE_FLAG_SELECTED);
    assert.equal(gpu.selectedCount, 1);
    assert.deepEqual(scene.getInstancedMeshDataPieces(42)![0].positions, sibling.positions);
    scene.setInstancedVisibility(new Set([41]), null);
    scene.setInstancedColorOverrides(new Map([[41, [1, 0, 0, 1]]]));
    lease.release();
    assert.deepEqual(color(0), [1, 0, 0, 1], 'release keeps the current colour override');
    assert.equal(lease.valid, false);
    assert.equal(flags(0), INSTANCE_FLAG_HIDDEN, 'release retains ordinary user hiding');
    scene.setInstancedVisibility(null, null);
    assert.equal(flags(0), 0);
    assert.equal(scene.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })?.expressId, 41);
    assert.throws(() => lease.setSuppressed(true), /stale/);
  });

  it('retains translations and rolls back failed GPU suppression without consuming ownership', () => {
    const { scene, flags, fail } = fixture();
    const before = scene.getInstancedMeshDataPieces(41)![0].positions;
    const lease = scene.retainInstancedOccurrence(41, 3);
    fail(); assert.throws(() => lease.setSuppressed(true), /GPU upload failure/);
    assert.equal(flags(0), 0); assert.equal(lease.valid, true);
    assert.ok(scene.getInstancedMeshDataPieces(41));
    lease.setSuppressed(true);
    fail(); assert.throws(() => lease.release(), /GPU upload failure/);
    assert.equal(lease.valid, true); assert.equal(flags(0), INSTANCE_FLAG_HIDDEN);
    scene.translateInstancedEntity(41, [2, 0, 0]);
    scene.setModelTranslation(3, [3, 0, 0]);
    assert.equal(scene.getEntityBoundingBox(41), null);
    assert.deepEqual(scene.getAllMeshDataExpressIds(), [42]);
    lease.release();
    const after = scene.getInstancedMeshDataPieces(41)![0].positions;
    for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i] + (i % 3 === 0 ? 5 : 0));
  });

  it('rejects another model and invalidates retained originals on removal or scene reset', () => {
    const { scene } = fixture();
    assert.throws(() => scene.retainInstancedOccurrence(41, 0), /specified model/);
    const lease = scene.retainInstancedOccurrence(41, 3); lease.setSuppressed(true);
    scene.removeInstancedTemplatesForModel(3);
    assert.equal(lease.valid, false); lease.release();
    assert.equal(scene.getAllInstancedMeshData().length, 0);
    const other = fixture(); const retained = other.scene.retainInstancedOccurrence(41, 3);
    retained.setSuppressed(true); other.scene.clearFlatGeometry();
    assert.equal(retained.valid, false);
    assert.equal(other.flags(0), 0);
    assert.equal(other.scene.getAllInstancedMeshData().length, 2);
    const deleted = other.scene.retainInstancedOccurrence(41, 3);
    deleted.setSuppressed(true); other.scene.removeMeshesForEntity(41);
    assert.equal(deleted.valid, false);
    assert.deepEqual([...other.scene.getInstancedEntityIds()], [42]);
    other.scene.clear();
  });
});
