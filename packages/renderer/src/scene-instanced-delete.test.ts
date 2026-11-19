/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import { INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 };

// #10639: deleting an instanced entity tombstones its slots with the HIDDEN
// flag. The opaque instanced pass picks its discard-free shader when
// `instancedMayDiscard()` is false (renderer.ts, `opaqueMode(...)`), and that
// shader ignores the flag, so a tombstoned slot must keep the answer true.

function fixture(modelIndex = 3) {
  const buffers = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      buffers.set(buffer, data); return buffer;
    },
    queue: { writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer) => {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      new Uint8Array(buffers.get(buffer)!, offset, bytes.byteLength).set(bytes);
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
  // Read through the scene's CURRENT template, so a recovered buffer is the one checked.
  const flags = (index: number) => {
    const gpu = scene.getInstancedTemplates()[0];
    return new DataView(buffers.get(gpu.instanceBuffer)!).getUint32(index * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);
  };
  return { scene, flags, device };
}

describe('deleted instanced occurrences stay discarded (#10639)', () => {
  it('keeps the discard path while a tombstoned slot exists and nothing else is hidden', () => {
    const { scene, flags } = fixture();
    assert.equal(scene.instancedMayDiscard(), false, 'control: nothing hidden, discard-free shader allowed');
    assert.equal(scene.removeMeshesForEntity(41), true);
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.equal(flags(1), 0, 'the other occurrence is untouched');
    assert.equal(scene.instancedMayDiscard(), true);
    assert.deepEqual([...scene.getInstancedEntityIds()], [42]);
  });

  it('survives visibility changes on the surviving occurrence', () => {
    const { scene, flags } = fixture();
    scene.removeMeshesForEntity(41);
    scene.setInstancedVisibility(new Set([42]), null);
    assert.equal(flags(1) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    scene.setInstancedVisibility(null, null);
    assert.equal(flags(1), 0);
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.equal(scene.instancedMayDiscard(), true);
  });

  it('counts an occurrence deleted while appearance-suppressed', () => {
    const { scene, flags } = fixture();
    scene.retainInstancedOccurrence(41, 3).setSuppressed(true);
    assert.equal(scene.instancedMayDiscard(), true);
    scene.removeMeshesForEntity(41);
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.equal(scene.instancedMayDiscard(), true, 'the suppression is forgotten; the tombstone is not');
  });

  it('stays hidden after device recovery rebuilds the instance buffer', () => {
    const { scene, flags, device } = fixture();
    scene.removeMeshesForEntity(41);
    const before = scene.getInstancedTemplates()[0];
    assert.equal(scene.prepareDeviceRecovery().ok, true);
    scene.discardGpuResourcesForRecovery();
    scene.restoreGpuResourcesAfterRecovery(device, {} as RenderPipeline);
    assert.notEqual(scene.getInstancedTemplates()[0], before, 'a new instance buffer was uploaded');
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.equal(flags(1), 0);
    assert.equal(scene.instancedMayDiscard(), true);
  });

  it('stays hidden after a model move re-uploads the instance buffer', () => {
    const { scene, flags } = fixture();
    scene.removeMeshesForEntity(41);
    assert.equal(scene.setModelTranslation(3, [10, 0, 0]), true);
    assert.equal(scene.setModelRotation(3, Math.PI / 2, [0, 0, 0]), true);
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.equal(flags(1) & INSTANCE_FLAG_HIDDEN, 0);
  });

  it('drops tombstones with their template, so a removed model no longer forces the discard path', () => {
    const { scene } = fixture();
    scene.removeMeshesForEntity(41);
    scene.removeInstancedTemplatesForModel(3);
    assert.equal(scene.instancedMayDiscard(), false);
    const cleared = fixture();
    cleared.scene.removeMeshesForEntity(41);
    cleared.scene.clear();
    assert.equal(cleared.scene.instancedMayDiscard(), false);
  });
});
