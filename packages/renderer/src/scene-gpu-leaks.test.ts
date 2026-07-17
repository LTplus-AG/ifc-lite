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

function fakeMesh(expressId: number, hydrated: boolean, modelIndex?: number): Mesh & {
  vertexBuffer: GPUBuffer & { destroyed: number };
  indexBuffer: GPUBuffer & { destroyed: number };
} {
  return {
    expressId,
    modelIndex,
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

  it('disposes the OTHER model\'s hydrated mesh when two federated models share an express id', () => {
    const scene = new Scene();
    const modelA = fakeMesh(42, true, 0);
    const modelB = fakeMesh(42, true, 1);
    scene['meshes'] = [modelA, modelB];

    // Selection moved to (model 1, id 42): same express id, different model.
    const disposed = scene.disposeHydratedMeshesExcept(new Set([42]), 1);

    assert.strictEqual(disposed, 1);
    assert.strictEqual(modelA.vertexBuffer.destroyed, 1, 'model 0 copy must be freed');
    assert.strictEqual(modelB.vertexBuffer.destroyed, 0, 'model 1 copy stays for the highlight');
    assert.deepStrictEqual(scene.getMeshes(), [modelB]);
  });

  it('keeps hydrated meshes from ALL models when no model index is scoped', () => {
    const scene = new Scene();
    const modelA = fakeMesh(42, true, 0);
    const modelB = fakeMesh(42, true, 1);
    scene['meshes'] = [modelA, modelB];
    assert.strictEqual(scene.disposeHydratedMeshesExcept(new Set([42])), 0);
    assert.strictEqual(modelA.vertexBuffer.destroyed, 0);
    assert.strictEqual(modelB.vertexBuffer.destroyed, 0);
  });

  it('selection thrash across three selections frees each stale mesh exactly once', () => {
    const scene = new Scene();
    const a = fakeMesh(1, true);
    scene['meshes'] = [a];

    // Select 2: a goes, b hydrates.
    scene.disposeHydratedMeshesExcept(new Set([2]));
    const b = fakeMesh(2, true);
    scene['meshes'] = [...scene.getMeshes(), b];

    // Select 3: b goes, c hydrates.
    scene.disposeHydratedMeshesExcept(new Set([3]));
    const c = fakeMesh(3, true);
    scene['meshes'] = [...scene.getMeshes(), c];

    // Deselect everything.
    scene.disposeHydratedMeshesExcept(new Set());

    assert.strictEqual(a.vertexBuffer.destroyed, 1);
    assert.strictEqual(a.indexBuffer.destroyed, 1);
    assert.strictEqual(b.vertexBuffer.destroyed, 1);
    assert.strictEqual(c.vertexBuffer.destroyed, 1);
    assert.strictEqual(scene.getMeshes().length, 0);

    // A redundant sweep must not double-destroy anything already gone.
    scene.disposeHydratedMeshesExcept(new Set());
    assert.strictEqual(a.vertexBuffer.destroyed, 1);
    assert.strictEqual(b.vertexBuffer.destroyed, 1);
    assert.strictEqual(c.vertexBuffer.destroyed, 1);
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

  it('never double-destroys: drop after drop, and clear() after drop', () => {
    const scene = new Scene();
    const a = fakeBatch(1, 'ck-a');
    scene['partialBatchCache'].set('key-a', a);
    scene['partialBatchCacheKeys'].set('src-a', 'key-a');
    scene['partialBatchCacheVersions'].set('src-a', 3);

    scene.dropAllPartialCaches();
    scene.dropAllPartialCaches();
    scene.clear(); // clear() routes through dropAllPartialCaches too

    assert.strictEqual((a.vertexBuffer as unknown as { destroyed: number }).destroyed, 1);
    assert.strictEqual((a.indexBuffer as unknown as { destroyed: number }).destroyed, 1);
  });
});

describe('Scene.setInstancedVisibility change detection', () => {
  // Minimal instanced state: one template, two occurrences. writeBuffer calls
  // are counted to observe flag flips reaching the (fake) GPU.
  function seedInstanced(scene: Scene): { writes: number } {
    const counter = { writes: 0 };
    scene['instancedDevice'] = {
      queue: { writeBuffer: () => { counter.writes++; } },
    } as unknown as GPUDevice;
    scene['instancedTemplates'] = [{ instanceBuffer: {} }] as never;
    scene['instancedEntityMap'].set(7, [{ templateIndex: 0, byteOffset: 0 }] as never);
    scene['instancedEntityMap'].set(8, [{ templateIndex: 0, byteOffset: 96 }] as never);
    return counter;
  }

  it('sees an IN-PLACE mutation of the hidden set (stays in lockstep with the batched path)', () => {
    const scene = new Scene();
    const counter = seedInstanced(scene);
    const hidden = new Set<number>();
    scene.setInstancedVisibility(hidden, undefined);
    assert.strictEqual(scene['instancedHidden'].size, 0);

    hidden.add(7); // same Set reference, mutated in place
    scene.setInstancedVisibility(hidden, undefined);
    assert.ok(scene['instancedHidden'].has(7), 'in-place add must reach the instanced hidden set');
    assert.ok(counter.writes > 0, 'the flag flip must be written to the instance buffer');
  });

  it('treats a fresh Set with identical content as unchanged (no recompute, no writes)', () => {
    const scene = new Scene();
    const counter = seedInstanced(scene);
    scene.setInstancedVisibility(new Set([7]), undefined);
    const writesAfterFirst = counter.writes;
    const versionAfterFirst = scene['lastInstancedVisibilityVersion'];

    scene.setInstancedVisibility(new Set([7]), undefined);
    assert.strictEqual(counter.writes, writesAfterFirst);
    assert.strictEqual(scene['lastInstancedVisibilityVersion'], versionAfterFirst);
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
