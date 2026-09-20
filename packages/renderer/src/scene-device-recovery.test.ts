/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
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

  it('keeps cold buckets lazy during recovery preparation', async () => {
    const scene = new Scene(), shell = batch(3);
    shell.gpuResident = false;
    shell.bounds = { min: [0, 0, 0], max: [1, 1, 1] };
    scene['buckets'].set('cold', { key: 'cold', meshData: [], batchedMesh: shell, vertexBytes: 0 });
    scene['coldBuckets'].add('cold');
    scene['drainColdTier'] = async () => assert.fail('recovery must not warm the cold tier');
    assert.deepStrictEqual(await scene.prepareDeviceRecovery(), { ok: true });
    assert.strictEqual(scene['coldBuckets'].has('cold'), true);
    assert.strictEqual(scene['buckets'].get('cold')?.batchedMesh, shell);
  });

  it('repartitions a lazy cold restore for a smaller replacement device', async () => {
    const scene = new Scene(), shell = batch(3), first = triangle(3), second = triangle(3);
    const key = scene['bucketBaseKey'](first);
    shell.colorKey = key; shell.gpuResident = false;
    shell.bounds = { min: [0, 0, 0], max: [1, 1, 1] };
    scene['buckets'].set(key, { key, meshData: [], batchedMesh: shell, vertexBytes: 0 });
    scene['batchedMeshes'] = [shell]; scene['coldBuckets'].add(key);
    scene.setColdGeometryProvider({ loadMeshesInBounds: async () => [first, second] });

    scene.restoreGpuResourcesAfterRecovery(
      { limits: { maxBufferSize: 120 } } as unknown as GPUDevice,
      {} as RenderPipeline,
    );
    scene.requestBatchResidency(shell);
    assert.strictEqual(scene.processResidencyRestores({} as GPUDevice, {} as RenderPipeline), 0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const uploads: MeshData[][] = [];
    scene['createBatchedMesh'] = (parts) => { uploads.push(parts); return batch(10 + uploads.length); };
    assert.strictEqual(scene.processResidencyRestores({} as GPUDevice, {} as RenderPipeline, Infinity), 2);
    assert.deepStrictEqual(uploads.map(parts => parts.map(part => part.expressId)), [[3], [3]]);
    assert.strictEqual(scene['buckets'].size, 2);
    assert.ok([...scene['buckets'].keys()].every(bucketKey => bucketKey.includes('#')),
      'every recovery partition is sealed from ambiguous provider re-hydration');

    for (const restored of scene['batchedMeshes']) restored.gpuResident = false;
    scene['hostBudgetBytes'] = 0;
    scene['enforceHostBudget']();
    assert.strictEqual(scene['coldBuckets'].size, 0, 'sealed recovery partitions cannot be cold-demoted');
    assert.strictEqual(scene['meshDataMap'].get(3)?.length, 2, 'both exact pieces remain owned once');
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

  it('repartitions flat buckets for a replacement device with a smaller buffer limit', () => {
    const scene = new Scene(), first = triangle(21), second = triangle(22), old = batch(1);
    const bucketState = { key: 'flat', meshData: [first, second], batchedMesh: old, vertexBytes: 168 };
    scene['buckets'].set('flat', bucketState);
    scene['meshDataBucket'].set(first, bucketState);
    scene['meshDataBucket'].set(second, bucketState);
    scene['batchedMeshes'] = [old];
    scene.discardGpuResourcesForRecovery();

    const uploads: Array<{ parts: MeshData[]; key: string | undefined }> = [];
    scene['createBatchedMesh'] = (parts, _color, _device, _pipeline, key) => {
      uploads.push({ parts, key });
      const replacement = batch(10 + uploads.length);
      replacement.colorKey = key ?? 'missing';
      return replacement;
    };
    const smaller = { limits: { maxBufferSize: 120 } } as unknown as GPUDevice;
    scene.restoreGpuResourcesAfterRecovery(smaller, {} as RenderPipeline);

    assert.deepStrictEqual(uploads.map(({ parts }) => parts), [[first], [second]]);
    assert.strictEqual(scene.getBatchedMeshes().length, 2);
    assert.strictEqual(scene['buckets'].size, 2);
    assert.notStrictEqual(uploads[0].key, uploads[1].key);
    assert.ok(uploads.every(({ key }) => key?.includes('#')),
      'all recovery-created partitions are sealed from cold demotion');
    assert.strictEqual(scene['meshDataBucket'].get(first)?.meshData[0], first);
    assert.strictEqual(scene['meshDataBucket'].get(second)?.meshData[0], second);
  });

  it('keeps a source bucket complete when a later repartition upload fails', () => {
    const scene = new Scene(), first = triangle(27), second = triangle(28), old = batch(1), partial = batch(2);
    const bucketState = { key: 'flat', meshData: [first, second], batchedMesh: old, vertexBytes: 168 };
    scene['buckets'].set('flat', bucketState);
    scene['meshDataBucket'].set(first, bucketState);
    scene['meshDataBucket'].set(second, bucketState);
    scene['meshDataMap'].set(27, [first]);
    scene['meshDataMap'].set(28, [second]);
    scene['batchedMeshes'] = [old];
    scene.discardGpuResourcesForRecovery();

    let upload = 0;
    scene['createBatchedMesh'] = () => {
      if (upload++ === 0) return partial;
      throw new Error('second partition failed');
    };
    const smaller = { limits: { maxBufferSize: 120 } } as unknown as GPUDevice;
    assert.throws(
      () => scene.restoreGpuResourcesAfterRecovery(smaller, {} as RenderPipeline),
      /second partition failed/,
    );

    assert.strictEqual(partial.vertexBuffer.destroyed, 1, 'the unreachable staged upload is released');
    assert.strictEqual(scene['buckets'].size, 1);
    assert.strictEqual(scene['buckets'].get('flat'), bucketState);
    assert.deepStrictEqual(bucketState.meshData, [first, second]);
    assert.strictEqual(scene['meshDataBucket'].get(first), bucketState);
    assert.strictEqual(scene['meshDataBucket'].get(second), bucketState);

    const restored: MeshData[][] = [];
    scene['createBatchedMesh'] = (parts) => { restored.push(parts); return batch(10 + restored.length); };
    assert.doesNotThrow(() => scene.restoreGpuResourcesAfterRecovery(smaller, {} as RenderPipeline));
    assert.deepStrictEqual(restored, [[first], [second]], 'retry restores every source piece');
  });

  it('invalidates and releases a detached authored transaction before recovery', () => {
    const scene = new Scene(), first = device();
    const pipeline = {
      getUniformBufferSize: () => 256,
      getBindGroupLayout: () => ({}),
    } as unknown as RenderPipeline;
    const prepared = scene.prepareAuthoredOwner([triangle(23)], first.gpu, pipeline);
    assert.ok(first.created.length > 0);
    assert.deepStrictEqual(first.created.map(value => value.destroyed), first.created.map(() => 0));

    scene.discardGpuResourcesForRecovery();
    assert.deepStrictEqual(first.created.map(value => value.destroyed), first.created.map(() => 1));
    assert.throws(() => prepared.commit(), /released/);
    assert.strictEqual(scene.getMeshData(23), undefined);
    prepared.dispose();
    assert.deepStrictEqual(first.created.map(value => value.destroyed), first.created.map(() => 1));
  });

  it('invalidates and releases a detached authored transaction on an ordinary scene reload', () => {
    const scene = new Scene(), first = device();
    const pipeline = {
      getUniformBufferSize: () => 256,
      getBindGroupLayout: () => ({}),
    } as unknown as RenderPipeline;
    const prepared = scene.prepareAuthoredOwner([triangle(24)], first.gpu, pipeline);

    scene.clearFlatGeometry();

    assert.deepStrictEqual(first.created.map(value => value.destroyed), first.created.map(() => 1));
    assert.throws(() => prepared.commit(), /released/);
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

  it('repartitions evicted shells for a smaller replacement limit without allocating buffers', () => {
    const scene = new Scene(), first = triangle(25), second = triangle(26), shell = batch(1);
    shell.colorKey = 'flat';
    shell.gpuResident = false;
    const bucketState = { key: 'flat', meshData: [first, second], batchedMesh: shell, vertexBytes: 168 };
    scene['buckets'].set('flat', bucketState);
    scene['batchedMeshes'] = [shell];
    scene.discardGpuResourcesForRecovery();

    const smaller = { limits: { maxBufferSize: 120 } } as unknown as GPUDevice;
    scene.restoreGpuResourcesAfterRecovery(smaller, {} as RenderPipeline);

    assert.strictEqual(scene['buckets'].size, 2);
    assert.ok([...scene['buckets'].keys()].every(key => key.includes('#')));
    assert.deepStrictEqual(scene.getBatchedMeshes().map((entry) => entry.gpuResident), [false, false]);
    assert.strictEqual(new Set(scene.getBatchedMeshes().map((entry) => entry.id)).size, 2);
    assert.strictEqual(shell.vertexBuffer.destroyed, 0);
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

  it('recreates slot-stable instances and reapplies selection and visibility with global colour overrides', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, shard(), 9);
    scene.setInstancedSelection(new Set([42]));
    scene.setInstancedVisibility(new Set([42]), null);
    scene.setColorOverrides(
      new Map([[42, [1, 0, 0, 0.5] as [number, number, number, number]]]),
      first.gpu,
      {} as RenderPipeline,
    );
    const old = scene.getInstancedTemplates()[0].vertexBuffer as unknown as FakeBuffer;

    scene.discardGpuResourcesForRecovery();
    const second = device();
    scene.restoreGpuResourcesAfterRecovery(second.gpu, {} as RenderPipeline);

    assert.strictEqual(old.destroyed, 1);
    assert.strictEqual(scene.getInstancedTemplates().length, 1);
    assert.strictEqual(scene.getInstancedTemplates()[0].modelIndex, 9);
    assert.strictEqual(scene.getInstancedTemplates()[0].selectedCount, 1);
    assert.deepStrictEqual([...scene.getInstancedEntityIds()], [42]);
    const flags = second.writes
      .filter(write => write.offset % 88 === 84)
      .map(write => new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength).getUint32(0, true));
    assert.deepStrictEqual(flags, [3], 'selected and hidden flags must survive the global override rebuild');
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

  it('restores an instance-specific override independently of the flat override map', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, shard(), 9);
    scene.setColorOverrides(new Map([[42, [1, 0, 0, 1]]]), first.gpu, {} as RenderPipeline);
    scene.setInstancedColorOverrides(new Map([[42, [0, 1, 0, 0.5]]]));
    scene.discardGpuResourcesForRecovery();

    const second = device();
    scene.restoreGpuResourcesAfterRecovery(second.gpu, {} as RenderPipeline);
    const color = second.writes
      .filter(write => write.offset % 88 === 68)
      .map(write => [...new Float32Array(write.data.buffer)])
      .at(-1);

    assert.deepStrictEqual(color, [0, 1, 0, 0.5]);
    assert.deepStrictEqual(scene['instancedOverrideColors']?.get(42), [0, 1, 0, 0.5]);
  });

  it('does not rebuild bounds for an authored replacement\'s suppressed instance', () => {
    const scene = new Scene(), first = device();
    scene.addInstancedShard(first.gpu, shard(), 9);
    const lease = scene['instanceSuppression'].acquire(42, 9);
    lease.setSuppressed(true);
    assert.strictEqual(scene.getInstancedEntityBounds(42), null);

    scene.discardGpuResourcesForRecovery();
    scene.restoreGpuResourcesAfterRecovery(device().gpu, {} as RenderPipeline);

    assert.strictEqual(scene.getInstancedEntityBounds(42), null);
    lease.release();
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
