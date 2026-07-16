/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { Mesh, BatchedMesh } from './types.js';

/**
 * Bookkeeping-side coverage for the GPU-leak fixes. The buffer allocation /
 * draw paths need a real GPUDevice (exercised in browser tests), but the
 * disposal + cache-invalidation logic is GPU-agnostic: we substitute buffers
 * with destroy-tracking stubs and assert the maps/arrays are cleaned up and
 * every buffer is destroyed exactly once.
 */

function fakeBuffer(): GPUBuffer & { destroyed: number } {
  const buf = {
    size: 0,
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
  return buf as unknown as GPUBuffer & { destroyed: number };
}

function fakeMesh(expressId: number, hydrated: boolean): Mesh & {
  vertexBuffer: GPUBuffer & { destroyed: number };
  indexBuffer: GPUBuffer & { destroyed: number };
} {
  return {
    expressId,
    vertexBuffer: fakeBuffer(),
    indexBuffer: fakeBuffer(),
    indexCount: 3,
    transform: { m: new Float32Array(16) } as unknown as Mesh['transform'],
    color: [0, 0, 0, 1],
    hydrated,
  } as Mesh & {
    vertexBuffer: GPUBuffer & { destroyed: number };
    indexBuffer: GPUBuffer & { destroyed: number };
  };
}

function fakeBatch(id: number, colorKey: string): BatchedMesh {
  return {
    id,
    colorKey,
    vertexBuffer: fakeBuffer(),
    indexBuffer: fakeBuffer(),
    indexCount: 3,
    color: [0, 0, 0, 1],
    expressIds: [],
  } as unknown as BatchedMesh;
}

describe('Scene.disposeHydratedMeshesExcept', () => {
  it('frees hydrated meshes not in the keep set and keeps the rest', () => {
    const scene = new Scene();
    const hydratedGone = fakeMesh(1, true);
    const hydratedKept = fakeMesh(2, true);
    const authored = fakeMesh(3, false); // not hydrated → never touched
    scene['meshes'] = [hydratedGone, hydratedKept, authored];

    const disposed = scene.disposeHydratedMeshesExcept(new Set([2]));

    assert.strictEqual(disposed, 1);
    assert.strictEqual(hydratedGone.vertexBuffer.destroyed, 1);
    assert.strictEqual(hydratedGone.indexBuffer.destroyed, 1);
    // Kept selected + authored geometry untouched.
    assert.strictEqual(hydratedKept.vertexBuffer.destroyed, 0);
    assert.strictEqual(authored.vertexBuffer.destroyed, 0);
    const remaining = scene.getMeshes();
    assert.deepStrictEqual(remaining, [hydratedKept, authored]);
  });

  it('never disposes authored (non-hydrated) meshes even when unselected', () => {
    const scene = new Scene();
    const authored = fakeMesh(9, false);
    scene['meshes'] = [authored];
    const disposed = scene.disposeHydratedMeshesExcept(new Set());
    assert.strictEqual(disposed, 0);
    assert.strictEqual(authored.vertexBuffer.destroyed, 0);
    assert.strictEqual(scene.getMeshes().length, 1);
  });

  it('is a no-op with no meshes', () => {
    const scene = new Scene();
    assert.strictEqual(scene.disposeHydratedMeshesExcept(new Set([1])), 0);
  });
});

describe('Scene.dropAllPartialCaches', () => {
  it('destroys every cached partial batch and clears all three cache maps', () => {
    const scene = new Scene();
    const a = fakeBatch(1, 'ck-a');
    const b = fakeBatch(2, 'ck-b');
    scene['partialBatchCache'].set('key-a', a);
    scene['partialBatchCache'].set('key-b', b);
    scene['partialBatchCacheKeys'].set('src-a', 'key-a');
    scene['partialBatchCacheKeys'].set('src-b', 'key-b');
    scene['partialBatchCacheVersions'].set('src-a', 7);
    scene['partialBatchCacheVersions'].set('src-b', 7);

    scene.dropAllPartialCaches();

    assert.strictEqual((a.vertexBuffer as unknown as { destroyed: number }).destroyed, 1);
    assert.strictEqual((b.vertexBuffer as unknown as { destroyed: number }).destroyed, 1);
    assert.strictEqual(scene['partialBatchCache'].size, 0);
    assert.strictEqual(scene['partialBatchCacheKeys'].size, 0);
    assert.strictEqual(scene['partialBatchCacheVersions'].size, 0);
  });

  it('is a cheap no-op when the caches are already empty', () => {
    const scene = new Scene();
    // Should not throw and should leave the maps empty.
    scene.dropAllPartialCaches();
    assert.strictEqual(scene['partialBatchCache'].size, 0);
  });
});

describe('Scene.getColorOverrideGeneration', () => {
  it('advances when overrides are cleared so the render loop can invalidate its epoch', () => {
    const scene = new Scene();
    const before = scene.getColorOverrideGeneration();
    scene.clearColorOverrides();
    const after = scene.getColorOverrideGeneration();
    assert.ok(after > before, 'generation should advance on clearColorOverrides');
  });
});
