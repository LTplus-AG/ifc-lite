/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import { INSTANCE_COLOR_OFFSET, INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_SELECTED, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 };

// #10767: a model move or rotation re-uploads the whole instance buffer from the CPU record
// (`placeSceneInstances`). State the scene wrote to the GPU alone was lost there.

function fixture(modelIndex = 3) {
  const buffers = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(desc.size);
      const buffer = { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
      buffers.set(buffer, data); return buffer;
    },
    // Whole-buffer re-uploads pass a raw ArrayBuffer; per-occurrence writes pass views.
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
  const view = () => new DataView(buffers.get(scene.getInstancedTemplates()[0].instanceBuffer)!);
  const flags = (i: number) => view().getUint32(i * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true);
  const color = (i: number) => [0, 1, 2, 3].map((c) => Math.round(view().getFloat32(i * INSTANCE_STRIDE_BYTES + INSTANCE_COLOR_OFFSET + c * 4, true) * 100) / 100);
  const move = () => {
    assert.equal(scene.setModelTranslation(modelIndex, [10, 0, 0]), true, 'the move re-uploads');
    assert.equal(scene.setModelRotation(modelIndex, Math.PI / 2, [0, 0, 0]), true, 'the rotation re-uploads');
  };
  return { scene, flags, color, move, device, modelIndex };
}

describe('live instance state survives a model move or rotation (#10767)', () => {
  it('keeps hide/isolate and selection flags', () => {
    const { scene, flags, move, modelIndex } = fixture();
    scene.setInstancedVisibility(new Set([42]), null);
    scene.setInstancedSelection(new Set([41]));
    move();
    assert.equal(flags(1) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN, 'the hidden occurrence stays hidden');
    assert.equal(flags(0) & INSTANCE_FLAG_SELECTED, INSTANCE_FLAG_SELECTED, 'the selected occurrence stays selected');
    // A later change reaches the re-uploaded record too.
    scene.setInstancedVisibility(null, null);
    scene.setInstancedSelection(new Set());
    scene.setModelTranslation(modelIndex, [20, 0, 0]);
    assert.equal(flags(0), 0);
    assert.equal(flags(1), 0);
  });

  it('keeps colour overrides and the X-Ray fade, and restores the original after them', () => {
    const { scene, color, move, modelIndex } = fixture();
    scene.setInstancedColorOverrides(new Map([[41, [1, 0, 0, 1]]]));
    scene.setInstancedGhosting(new Set([41]), null, 0.2);
    move();
    assert.deepEqual(color(0), [1, 0, 0, 1], 'override kept');
    assert.deepEqual(color(1), [0.4, 0.5, 0.6, 0.2], 'ghost fade kept');
    scene.setInstancedColorOverrides(null);
    scene.setInstancedGhosting(null, null, 0.2);
    scene.setModelTranslation(modelIndex, [20, 0, 0]);
    assert.deepEqual(color(0), [0.4, 0.5, 0.6, 1], 'the original colour after the override clears');
    assert.deepEqual(color(1), [0.4, 0.5, 0.6, 1]);
  });

  it('keeps an appearance suppression, and its release', () => {
    const { scene, flags, move, modelIndex } = fixture();
    const lease = scene.retainInstancedOccurrence(41, modelIndex);
    lease.setSuppressed(true);
    move();
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN, 'the suppressed original stays hidden beside its replacement');
    lease.release();
    scene.setModelTranslation(modelIndex, [20, 0, 0]);
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, 0);
  });

  it('keeps them through device recovery, which uploads the same record', () => {
    const { scene, flags, color, device } = fixture();
    scene.setInstancedVisibility(new Set([42]), null);
    scene.setInstancedColorOverrides(new Map([[41, [1, 0, 0, 1]]]));
    assert.equal(scene.prepareDeviceRecovery().ok, true);
    scene.discardGpuResourcesForRecovery();
    scene.restoreGpuResourcesAfterRecovery(device, {} as RenderPipeline);
    assert.equal(flags(1) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN);
    assert.deepEqual(color(0), [1, 0, 0, 1]);
  });

  it('keeps a deleted entity hidden while live state on its template changes and the model moves', () => {
    const { scene, flags, move } = fixture();
    scene.setInstancedVisibility(new Set([41]), null);
    scene.setInstancedSelection(new Set([41, 42]));
    scene.removeMeshesForEntity(41);
    scene.setInstancedVisibility(null, null); // the hidden set no longer names 41
    scene.setInstancedSelection(new Set([42]));
    move();
    assert.equal(flags(0) & INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_HIDDEN, 'the #10639 tombstone survives the #10767 re-upload');
    assert.equal(flags(1), INSTANCE_FLAG_SELECTED, 'and the survivor keeps its live state');
  });
});
