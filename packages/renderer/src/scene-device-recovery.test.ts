/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh, Mesh } from './types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64,
};

interface FakeBuffer {
  size: number;
  destroyed: number;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

function buffer(size = 16): FakeBuffer {
  const backing = new ArrayBuffer(size);
  return { size, destroyed: 0, getMappedRange: () => backing, unmap() {}, destroy() { this.destroyed++; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function device() {
  const created: FakeBuffer[] = [], writes: Array<{ offset: number; data: Uint8Array }> = [];
  return {
    created,
    writes,
    gpu: {
      limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createBuffer(desc: { size: number }) { const value = buffer(desc.size); created.push(value); return value; },
      createBindGroup() { return {}; },
      queue: {
        writeBuffer(_target: unknown, offset: number, source: ArrayBufferView) {
          writes.push({ offset, data: new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() });
        },
      },
    } as unknown as GPUDevice,
  };
}

function batch(id: number): BatchedMesh & { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer } {
  return {
    id, colorKey: `batch-${id}`, vertexBuffer: buffer(), indexBuffer: buffer(), indexCount: 3,
    color: [1, 1, 1, 1], expressIds: [id],
  } as unknown as BatchedMesh & { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer };
}

function triangle(id: number): MeshData {
  return {
    expressId: id,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.2, 0.3, 0.4, 1],
  };
}

function shard(): DecodedInstancedShard {
  return {
    templates: [{ ...triangle(0), origin: [0, 0, 0] }],
    instances: [{
      templateIndex: 0,
      entityId: 42,
      color: [0.4, 0.5, 0.6, 1],
      transform: new Float32Array([1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4, 0, 0, 0, 1]),
    }],
    carriesItemIds: false,
  };
}

function repeatedEntityShard(): DecodedInstancedShard {
  return {
    templates: [{ ...triangle(0), origin: [0, 0, 0] }],
    instances: [
      {
        templateIndex: 0,
        entityId: 42,
        color: [0.1, 0.2, 0.3, 1],
        transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
      {
        templateIndex: 0,
        entityId: 42,
        color: [0.7, 0.8, 0.9, 1],
        transform: new Float32Array([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
    ],
    carriesItemIds: false,
  };
}

describe('Scene device recovery (#4885)', () => {
  it('refuses GPU-only and unsettled scenes before releasing anything', async () => {
    const released = new Scene();
    released['geometryReleased'] = true;
    assert.deepStrictEqual(await released.prepareDeviceRecovery(), { ok: false, reason: 'cpu-geometry-released' });

    const streaming = new Scene();
    streaming['streamingFragments'] = [batch(1)];
    assert.deepStrictEqual(await streaming.prepareDeviceRecovery(), { ok: false, reason: 'scene-not-settled' });

    const previewing = new Scene();
    previewing['appearanceController'] = {
      hasActiveDrafts: () => true,
    } as unknown as NonNullable<Scene['appearanceController']>;
    assert.deepStrictEqual(await previewing.prepareDeviceRecovery(), { ok: false, reason: 'scene-not-settled' });

    const authored = new Scene();
    authored['meshes'] = [{ hydrated: false } as Mesh];
    assert.deepStrictEqual(await authored.prepareDeviceRecovery(), { ok: false, reason: 'unsupported-authored-meshes' });
  });

  it('fails instead of silently dropping a cold bucket that cannot be restored', async () => {
    const scene = new Scene(), shell = batch(3);
    shell.bounds = { min: [0, 0, 0], max: [1, 1, 1] };
    scene['buckets'].set('cold', { key: 'cold', meshData: [], batchedMesh: shell, vertexBytes: 0 });
    scene['coldBuckets'].add('cold');
    scene.setColdGeometryProvider({ loadMeshesInBounds: async () => [] });
    const warning = mock.method(console, 'warn', () => undefined);
    try {
      assert.deepStrictEqual(
        await scene.prepareDeviceRecovery(),
        { ok: false, reason: 'cold-restore-failed' },
      );
      assert.strictEqual(scene['coldBuckets'].has('cold'), true);
    } finally {
      warning.mock.restore();
    }
  });

  it('rejects an authored mesh added while cold restoration is awaiting I/O', async () => {
    const scene = new Scene(), gate = deferred<void>(), drainStarted = deferred<void>();
    scene['drainColdTier'] = async () => {
      drainStarted.resolve();
      await gate.promise;
    };

    const preparation = scene.prepareDeviceRecovery();
    await drainStarted.promise;
    scene['meshes'] = [{ hydrated: false } as Mesh];
    gate.resolve();

    assert.deepStrictEqual(
      await preparation,
      { ok: false, reason: 'unsupported-authored-meshes' },
      'a drawable with no CPU source must not be accepted and then silently discarded',
    );
  });

  it('replaces flat GPU batches without losing their CPU pieces', () => {
    const scene = new Scene(), source = triangle(7), old = batch(1), replacement = batch(2);
    const bucketState = { key: 'flat', meshData: [source], batchedMesh: old, vertexBytes: source.positions.byteLength };
    scene['buckets'].set('flat', bucketState);
    scene['meshDataMap'].set(7, [source]);
    scene['meshDataBucket'].set(source, bucketState);
    scene['batchedMeshes'] = [old];
    scene.discardGpuResourcesForRecovery();

    assert.strictEqual(old.vertexBuffer.destroyed, 1);
    assert.strictEqual(scene.getMeshData(7), source, 'CPU reconstruction source must survive teardown');
    scene['createBatchedMesh'] = () => replacement;
    scene.restoreGpuResourcesAfterRecovery({} as GPUDevice, {} as RenderPipeline);

    assert.deepStrictEqual(scene.getBatchedMeshes(), [replacement]);
    assert.strictEqual(scene.getMeshData(7), source);
    assert.strictEqual(scene['buckets'].get('flat')?.batchedMesh, replacement);
  });

  it('preserves evicted residency shells instead of eagerly re-uploading them', () => {
    const scene = new Scene(), source = triangle(10), shell = batch(1), replacement = batch(2);
    shell.colorKey = 'flat';
    shell.gpuResident = false;
    const bucketState = { key: 'flat', meshData: [source], batchedMesh: shell, vertexBytes: source.positions.byteLength };
    scene['buckets'].set('flat', bucketState);
    scene['batchedMeshes'] = [shell];
    scene.discardGpuResourcesForRecovery();

    assert.strictEqual(shell.vertexBuffer.destroyed, 0, 'already-evicted buffers must not be disposed again');
    scene['createBatchedMesh'] = () => assert.fail('an evicted bucket must stay lazy during recovery');
    scene.restoreGpuResourcesAfterRecovery({} as GPUDevice, {} as RenderPipeline);
    assert.deepStrictEqual(scene.getBatchedMeshes(), [shell]);
    assert.strictEqual(bucketState.batchedMesh, shell);

    scene.requestBatchResidency(shell);
    scene['createBatchedMesh'] = () => replacement;
    assert.strictEqual(scene.processResidencyRestores({} as GPUDevice, {} as RenderPipeline), 1);
    assert.strictEqual(bucketState.batchedMesh, replacement);
  });

  it('rebinds cached appearance-history GPU closures to the replacement device', () => {
    const scene = new Scene(), source = triangle(11), old = batch(1), replacement = batch(2);
    const first = device(), second = device();
    const oldPipeline = {} as RenderPipeline, replacementPipeline = {} as RenderPipeline;
    const bucketState = { key: 'flat', meshData: [source], batchedMesh: old, vertexBytes: source.positions.byteLength };
    scene['buckets'].set('flat', bucketState);
    scene['batchedMeshes'] = [old];
    scene.appearancePreview(first.gpu, oldPipeline);
    scene.discardGpuResourcesForRecovery();

    let capturedDevice: GPUDevice | undefined, capturedPipeline: RenderPipeline | undefined;
    scene['createBatchedMesh'] = (_parts, _color, targetDevice, targetPipeline) => {
      capturedDevice = targetDevice;
      capturedPipeline = targetPipeline;
      return replacement;
    };
    scene.restoreGpuResourcesAfterRecovery(second.gpu, replacementPipeline);
    capturedDevice = undefined;
    capturedPipeline = undefined;

    scene['appearanceAccessState']?.buckets.create([source], 'appearance-test');
    assert.strictEqual(capturedDevice, second.gpu);
    assert.strictEqual(capturedPipeline, replacementPipeline);
  });

  it('recreates slot-stable instances and reapplies selection, hide, and colour state', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, shard(), 9);
    scene.setInstancedSelection(new Set([42]));
    scene.setInstancedVisibility(new Set([42]), null);
    scene.setInstancedColorOverrides(new Map([[42, [1, 0, 0, 0.5] as const]]));
    const old = scene.getInstancedTemplates()[0].vertexBuffer as unknown as FakeBuffer;

    scene.discardGpuResourcesForRecovery();
    const second = device();
    scene.restoreGpuResourcesAfterRecovery(second.gpu, {} as RenderPipeline);

    assert.strictEqual(old.destroyed, 1);
    assert.strictEqual(scene.getInstancedTemplates().length, 1);
    assert.strictEqual(scene.getInstancedTemplates()[0].modelIndex, 9);
    assert.strictEqual(scene.getInstancedTemplates()[0].selectedCount, 1);
    assert.deepStrictEqual([...scene.getInstancedEntityIds()], [42]);
    assert.ok(second.writes.length >= 2, 'flags and override colour must be re-applied to the new instance buffer');
  });

  it('preserves distinct occurrence colours for a shared express ID', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, repeatedEntityShard(), 9);
    scene['instancedGhosted'].add(42);
    scene['lastGhostAlpha'] = 0.25;
    scene.discardGpuResourcesForRecovery();

    const second = device();
    scene.restoreGpuResourcesAfterRecovery(second.gpu, {} as RenderPipeline);
    const colors = second.writes
      .filter(write => write.offset % 88 === 68)
      .map(write => [...new Float32Array(write.data.buffer)]);

    assert.strictEqual(colors.length, 2);
    const expected = [[0.1, 0.2, 0.3, 0.25], [0.7, 0.8, 0.9, 0.25]];
    for (let occurrence = 0; occurrence < expected.length; occurrence++) {
      for (let channel = 0; channel < expected[occurrence].length; channel++) {
        assert.ok(Math.abs(colors[occurrence][channel] - expected[occurrence][channel]) < 1e-6);
      }
    }
  });

  it('cleans a partial replacement upload and remains retryable', () => {
    const scene = new Scene(), source = triangle(8), later = triangle(9), old = batch(1), partial = batch(2);
    const bucketState = { key: 'flat', meshData: [source], batchedMesh: old, vertexBytes: source.positions.byteLength };
    const laterBucket = { key: 'later', meshData: [later], batchedMesh: null, vertexBytes: later.positions.byteLength };
    scene['buckets'].set('flat', bucketState);
    scene['buckets'].set('later', laterBucket);
    scene['batchedMeshes'] = [old];
    scene.discardGpuResourcesForRecovery();
    scene['createBatchedMesh'] = (_pieces, _color, _device, _pipeline, key) => {
      if (key === 'flat') return partial;
      throw new Error('replacement failed');
    };

    assert.throws(() => scene.restoreGpuResourcesAfterRecovery({} as GPUDevice, {} as RenderPipeline), /replacement failed/);
    assert.strictEqual(partial.vertexBuffer.destroyed, 1);
    assert.strictEqual(scene['buckets'].get('flat')?.meshData[0], source);
    assert.deepStrictEqual(scene.getBatchedMeshes(), []);
  });

  it('destroys partial instance allocations when a replacement upload fails', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, shard(), 9);
    scene.discardGpuResourcesForRecovery();

    const created: FakeBuffer[] = [];
    const failing = {
      limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createBuffer(desc: { size: number }) {
        if (created.length === 2) throw new Error('instance allocation failed');
        const value = buffer(desc.size);
        created.push(value);
        return value;
      },
    } as unknown as GPUDevice;

    assert.throws(
      () => scene.restoreGpuResourcesAfterRecovery(failing, {} as RenderPipeline),
      /instance allocation failed/,
    );
    assert.deepStrictEqual(created.map(value => value.destroyed), [1, 1]);
    assert.deepStrictEqual(scene.getInstancedTemplates(), []);
  });
});
