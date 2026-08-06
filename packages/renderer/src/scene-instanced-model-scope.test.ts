/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';

/**
 * Model-scoped instanced-template storage (Refs #1912, #2073).
 *
 * A template is identified by `(modelIndex, templateIndex)`, where
 * `templateIndex` is a STABLE slot in the scene's template array rather than a
 * position in a densely-packed list. The properties pinned here are the ones a
 * federated load and a per-model teardown both depend on:
 *
 *  - adding or removing one model's templates never shifts another model's
 *    `templateIndex` values (occurrences hold those by value);
 *  - removing a model frees exactly its own GPU handles and no others;
 *  - `getResidentGpuBytes()` stays exact across add/remove;
 *  - a shared express id (two models, same id — the federated case) loses only
 *    the removed model's occurrences.
 *
 * Every structural test uses TWO models with DIFFERENT template counts, so a
 * model tag can never be mistaken for a global array position.
 *
 * The buffer allocation itself needs no real GPU: `addInstancedShard` only asks
 * the device for sized, mapped buffers, so a recording stub exercises the real
 * interleave / bounds-fold / entity-map code and lets us assert on the exact
 * handles destroyed. The draw + pick passes need a real context and stay in the
 * browser/E2E lanes.
 */

// WebGPU enum globals used by Scene buffer creation (not defined in node) —
// same stub the other renderer tests install.
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

interface FakeBuffer {
  size: number;
  destroyed: number;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

function fakeDevice(): { device: GPUDevice; created: FakeBuffer[] } {
  const created: FakeBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: { size: number }) => {
      const backing = new ArrayBuffer(desc.size);
      const buf: FakeBuffer = {
        size: desc.size,
        destroyed: 0,
        getMappedRange: () => backing,
        unmap() {},
        destroy() { this.destroyed++; },
      };
      created.push(buf);
      return buf;
    },
    queue: { writeBuffer: () => {} },
  };
  return { device: device as unknown as GPUDevice, created };
}

/** Row-major translation mat4 (the `DecodedInstance.transform` convention). */
function rowMajorTranslation(x: number, y: number, z: number): Float32Array {
  return new Float32Array([
    1, 0, 0, x,
    0, 1, 0, y,
    0, 0, 1, z,
    0, 0, 0, 1,
  ]);
}

/**
 * A shard with `templateCount` distinct unit triangles, one opaque occurrence
 * each, entity ids taken from `entityIds` (occurrence i belongs to template i).
 * Template i gets i+1 triangles so the templates differ in buffer size — a
 * uniform size would let a byte-accounting bug pass by coincidence.
 */
function shard(templateCount: number, entityIds: number[]): DecodedInstancedShard {
  const templates = [];
  const instances = [];
  for (let t = 0; t < templateCount; t++) {
    const tris = t + 1;
    const positions = new Float32Array(tris * 9);
    const normals = new Float32Array(tris * 9);
    const indices = new Uint32Array(tris * 3);
    for (let k = 0; k < tris; k++) {
      positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], k * 9);
      normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1], k * 9);
      indices.set([k * 3, k * 3 + 1, k * 3 + 2], k * 3);
    }
    templates.push({ positions, normals, indices, origin: [0, 0, 0] as [number, number, number] });
    instances.push({
      templateIndex: t,
      entityId: entityIds[t],
      color: [1, 1, 1, 1] as [number, number, number, number],
      transform: rowMajorTranslation(t, 0, 0),
    });
  }
  return { templates, instances };
}

/** The `(modelIndex, slot)` pairs of every live template, in slot order. */
function liveTags(scene: Scene): Array<[number, number]> {
  const slots = scene['instancedTemplates'] as ReadonlyArray<{ modelIndex: number } | undefined>;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < slots.length; i++) {
    const t = slots[i];
    if (t) out.push([t.modelIndex, i]);
  }
  return out;
}

/** Occurrence slots recorded for `expressId`, in insertion order. */
function occSlots(scene: Scene, expressId: number): number[] {
  const map = scene['instancedEntityMap'] as Map<number, Array<{ templateIndex: number }>>;
  return (map.get(expressId) ?? []).map((o) => o.templateIndex);
}

/** Two models: model 3 has 2 templates (ids 10, 11), model 7 has 3 (ids 20, 21, 22). */
function twoModelScene() {
  const scene = new Scene();
  const { device, created } = fakeDevice();
  scene.addInstancedShard(device, shard(2, [10, 11]), 3);
  const afterFirst = created.length;
  scene.addInstancedShard(device, shard(3, [20, 21, 22]), 7);
  return { scene, device, created, modelA: created.slice(0, afterFirst), modelB: created.slice(afterFirst) };
}

describe('Scene instanced templates are model-tagged', () => {
  it('tags each uploaded template with its owning model and keeps both models resident', () => {
    const { scene } = twoModelScene();
    assert.deepStrictEqual(liveTags(scene), [[3, 0], [3, 1], [7, 2], [7, 3], [7, 4]]);
    assert.strictEqual(scene.getInstancedTemplates().length, 5);
    assert.deepStrictEqual(
      scene.getInstancedTemplates().map((t) => t.modelIndex),
      [3, 3, 7, 7, 7],
    );
  });

  it('defaults the model tag to 0 when the caller does not pass one', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, shard(2, [1, 2]));
    assert.deepStrictEqual(scene.getInstancedTemplates().map((t) => t.modelIndex), [0, 0]);
  });

  it('reports the model indices that currently hold templates', () => {
    const { scene } = twoModelScene();
    assert.deepStrictEqual([...scene.getInstancedModelIndices()].sort((a, b) => a - b), [3, 7]);
    scene.removeInstancedTemplatesForModel(3);
    assert.deepStrictEqual([...scene.getInstancedModelIndices()], [7]);
  });

  it('reports ownership even while the instanced pass is hidden (Types view)', () => {
    // The documented difference from `getInstancedTemplates()`: hiding the
    // pass must not change who OWNS templates, or a Types-view toggle would
    // make a per-model teardown think the model holds nothing. Adding the
    // `instancedVisible` early-return to `getInstancedModelIndices` survived
    // the suite before this assertion existed (measured).
    const { scene } = twoModelScene();
    scene.setInstancedVisible(false);
    assert.strictEqual(scene.getInstancedTemplates().length, 0, 'the pass is hidden');
    assert.deepStrictEqual(
      [...scene.getInstancedModelIndices()].sort((a, b) => a - b), [3, 7]);
    // …and a removal taken while hidden is still model-scoped.
    assert.strictEqual(scene.removeInstancedTemplatesForModel(3), 2);
    assert.deepStrictEqual([...scene.getInstancedModelIndices()], [7]);
  });
});

describe('Scene.removeInstancedTemplatesForModel — index stability', () => {
  it('does not shift the surviving model\'s template slots', () => {
    const { scene } = twoModelScene();
    const before = scene.getInstancedTemplates().filter((t) => t.modelIndex === 7);
    const slotsBefore = [occSlots(scene, 20), occSlots(scene, 21), occSlots(scene, 22)];
    assert.deepStrictEqual(slotsBefore, [[2], [3], [4]]);

    assert.strictEqual(scene.removeInstancedTemplatesForModel(3), 2);

    // Occurrence records hold slots BY VALUE; they must still name the same
    // templates, by identity, not merely by index.
    assert.deepStrictEqual([occSlots(scene, 20), occSlots(scene, 21), occSlots(scene, 22)], slotsBefore);
    const slots = scene['instancedTemplates'] as ReadonlyArray<unknown>;
    assert.strictEqual(slots[2], before[0]);
    assert.strictEqual(slots[3], before[1]);
    assert.strictEqual(slots[4], before[2]);
    assert.deepStrictEqual(liveTags(scene), [[7, 2], [7, 3], [7, 4]]);
  });

  it('does not shift existing slots when a further model is added after a removal', () => {
    const { scene, device } = twoModelScene();
    scene.removeInstancedTemplatesForModel(3);
    scene.addInstancedShard(device, shard(1, [30]), 9);

    assert.deepStrictEqual([occSlots(scene, 20), occSlots(scene, 21), occSlots(scene, 22)], [[2], [3], [4]]);
    // The new model takes a fresh slot — a freed slot is never recycled, so a
    // stale occurrence reference can never resolve to a different model's template.
    assert.deepStrictEqual(occSlots(scene, 30), [5]);
    assert.deepStrictEqual(liveTags(scene), [[7, 2], [7, 3], [7, 4], [9, 5]]);
  });

  it('keeps the CPU template array aligned with the GPU slots after a removal', () => {
    const { scene } = twoModelScene();
    scene.removeInstancedTemplatesForModel(3);
    const cpu = scene['instancedTemplateCpu'] as ReadonlyArray<{ indices: Uint32Array } | undefined>;
    assert.strictEqual(cpu[0], undefined);
    assert.strictEqual(cpu[1], undefined);
    // Model 7's templates carry 1, 2 and 3 triangles at slots 2, 3, 4.
    assert.deepStrictEqual([cpu[2]?.indices.length, cpu[3]?.indices.length, cpu[4]?.indices.length], [3, 6, 9]);
  });

  it('keeps CPU templates slot-aligned after releaseGeometryData() drops them', () => {
    // releaseGeometryData() empties the CPU template array while the GPU slots
    // live on. A shard uploaded afterwards must land on its GPU slot, not at
    // CPU index 0 — otherwise every CPU consumer (raycast / measure / section /
    // export) reads a different template's triangles than the occurrence names.
    const { scene, device } = twoModelScene();
    scene.releaseGeometryData();
    scene.addInstancedShard(device, shard(1, [30]), 9);

    assert.deepStrictEqual(occSlots(scene, 30), [5]);
    const cpu = scene['instancedTemplateCpu'] as ReadonlyArray<{ indices: Uint32Array } | undefined>;
    assert.strictEqual(cpu[0], undefined, 'the new template must not squat on a released slot');
    assert.strictEqual(cpu[5]?.indices.length, 3);
    assert.strictEqual(scene.getInstancedMeshDataPieces(30)?.length, 1);
  });
});

describe('Scene.removeInstancedTemplatesForModel — disposal', () => {
  it('destroys exactly the removed model\'s GPU handles, once each', () => {
    const { scene, modelA, modelB } = twoModelScene();
    assert.strictEqual(modelA.length, 6, '2 templates x (vertex, index, instance)');
    assert.strictEqual(modelB.length, 9, '3 templates x (vertex, index, instance)');

    scene.removeInstancedTemplatesForModel(3);

    assert.deepStrictEqual(modelA.map((b) => b.destroyed), [1, 1, 1, 1, 1, 1]);
    assert.deepStrictEqual(modelB.map((b) => b.destroyed), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('does not re-destroy an already-removed model\'s handles on clear()', () => {
    const { scene, modelA, modelB } = twoModelScene();
    scene.removeInstancedTemplatesForModel(3);
    scene.clear();
    assert.deepStrictEqual(modelA.map((b) => b.destroyed), [1, 1, 1, 1, 1, 1]);
    assert.deepStrictEqual(modelB.map((b) => b.destroyed), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.strictEqual(scene.getInstancedTemplates().length, 0);
  });

  it('is a no-op for a model that holds no templates', () => {
    const { scene, modelA, modelB } = twoModelScene();
    assert.strictEqual(scene.removeInstancedTemplatesForModel(99), 0);
    assert.deepStrictEqual(modelA.map((b) => b.destroyed), [0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(modelB.map((b) => b.destroyed), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(liveTags(scene), [[3, 0], [3, 1], [7, 2], [7, 3], [7, 4]]);
  });

  it('is a no-op on an empty scene', () => {
    const scene = new Scene();
    assert.strictEqual(scene.removeInstancedTemplatesForModel(0), 0);
    assert.strictEqual(scene.getInstancedTemplates().length, 0);
  });

  it('leaves no live templates once the last model is removed', () => {
    const { scene, modelA, modelB } = twoModelScene();
    assert.strictEqual(scene.removeInstancedTemplatesForModel(3), 2);
    assert.strictEqual(scene.removeInstancedTemplatesForModel(7), 3);
    assert.strictEqual(scene.getInstancedTemplates().length, 0);
    assert.deepStrictEqual([...scene.getInstancedModelIndices()], []);
    assert.deepStrictEqual(modelA.concat(modelB).map((b) => b.destroyed), new Array(15).fill(1));
    assert.strictEqual(scene.getResidentGpuBytes().instanced, 0);
  });
});

describe('Scene.removeInstancedTemplatesForModel — GPU byte accounting', () => {
  it('subtracts exactly the removed model\'s bytes and no others', () => {
    const { scene, modelA, modelB } = twoModelScene();
    const bytesA = modelA.reduce((n, b) => n + b.size, 0);
    const bytesB = modelB.reduce((n, b) => n + b.size, 0);
    assert.ok(bytesA > 0 && bytesB > 0 && bytesA !== bytesB, 'the two models must differ in size');
    assert.strictEqual(scene.getResidentGpuBytes().instanced, bytesA + bytesB);

    scene.removeInstancedTemplatesForModel(3);
    assert.strictEqual(scene.getResidentGpuBytes().instanced, bytesB);

    scene.removeInstancedTemplatesForModel(7);
    assert.strictEqual(scene.getResidentGpuBytes().instanced, 0);
  });

  it('counts a model added after a removal without counting the freed slots', () => {
    const { scene, device, modelB, created } = twoModelScene();
    scene.removeInstancedTemplatesForModel(3);
    const beforeAdd = created.length;
    scene.addInstancedShard(device, shard(1, [30]), 9);
    const bytesB = modelB.reduce((n, b) => n + b.size, 0);
    const bytesC = created.slice(beforeAdd).reduce((n, b) => n + b.size, 0);
    assert.strictEqual(scene.getResidentGpuBytes().instanced, bytesB + bytesC);
  });
});

describe('Scene.removeInstancedTemplatesForModel — entity bookkeeping', () => {
  it('drops the removed model\'s express ids and keeps the survivor\'s', () => {
    const { scene } = twoModelScene();
    scene.removeInstancedTemplatesForModel(3);
    assert.strictEqual(scene.isInstancedEntity(10), false);
    assert.strictEqual(scene.isInstancedEntity(11), false);
    assert.strictEqual(scene.isInstancedEntity(20), true);
    assert.strictEqual(scene.getInstancedEntityCount(), 3);
  });

  it('keeps a shared express id alive when only one model\'s occurrence is removed', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    // The federated case before id offsetting: both models use express id 42.
    scene.addInstancedShard(device, shard(2, [42, 11]), 3);
    scene.addInstancedShard(device, shard(3, [42, 21, 22]), 7);
    assert.deepStrictEqual(occSlots(scene, 42), [0, 2]);

    scene.removeInstancedTemplatesForModel(3);
    assert.strictEqual(scene.isInstancedEntity(42), true);
    assert.deepStrictEqual(occSlots(scene, 42), [2], 'only model 3\'s occurrence is pruned');
  });

  it('drops selection/hidden/override bookkeeping only for ids that lost every occurrence', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, shard(2, [42, 11]), 3);
    scene.addInstancedShard(device, shard(3, [42, 21, 22]), 7);
    scene.setInstancedSelection(new Set([42, 11]));
    assert.deepStrictEqual([...(scene['instancedSelected'] as Set<number>)].sort((a, b) => a - b), [11, 42]);

    scene.removeInstancedTemplatesForModel(3);
    assert.deepStrictEqual([...(scene['instancedSelected'] as Set<number>)], [42]);
  });

  it('drops the HIDDEN and OVERRIDE bookkeeping too, not just the selection', () => {
    // Selection is one of three sibling sets pruned on the same lines. With
    // only `instancedSelected` asserted, deleting the `instancedHidden` /
    // `instancedOverridden` lines survives the suite (measured) — and a stale
    // entry there means a re-loaded model's occurrence of the same express id
    // comes back invisible or wearing a dead lens colour.
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, shard(2, [42, 11]), 3);
    scene.addInstancedShard(device, shard(3, [42, 21, 22]), 7);

    // 11 exists only in model 3; 42 is shared, so it must survive all three.
    scene.setInstancedVisibility(new Set([11, 42]), null);
    scene.setInstancedColorOverrides(new Map<number, readonly [number, number, number, number]>([
      [11, [1, 0, 0, 1]],
      [42, [0, 1, 0, 1]],
    ]));
    assert.deepStrictEqual(
      [...(scene['instancedHidden'] as Set<number>)].sort((a, b) => a - b), [11, 42]);
    assert.deepStrictEqual(
      [...(scene['instancedOverridden'] as Set<number>)].sort((a, b) => a - b), [11, 42]);

    scene.removeInstancedTemplatesForModel(3);
    assert.deepStrictEqual([...(scene['instancedHidden'] as Set<number>)], [42]);
    assert.deepStrictEqual([...(scene['instancedOverridden'] as Set<number>)], [42]);
  });

  it('decrements the surviving templates\' selectedCount only for pruned occurrences', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, shard(2, [42, 11]), 3);
    scene.addInstancedShard(device, shard(3, [42, 21, 22]), 7);
    scene.setInstancedSelection(new Set([42]));
    const survivor = scene.getInstancedTemplates().find((t) => t.modelIndex === 7)!;
    assert.strictEqual(survivor.selectedCount, 1);

    scene.removeInstancedTemplatesForModel(3);
    assert.strictEqual(survivor.selectedCount, 1, 'model 7 still owns a selected occurrence');
  });
});

/**
 * A single-occurrence shard with an explicit world translation, for tests that
 * need distinguishable, non-overlapping world AABBs (the `shard()` helper above
 * always starts each shard's template 0 at local translation (0,0,0), so two
 * shards built with it collide in world space).
 */
function singleOccShard(entityId: number, tx: number): DecodedInstancedShard {
  return {
    templates: [{
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      origin: [0, 0, 0] as [number, number, number],
    }],
    instances: [{
      templateIndex: 0,
      entityId,
      color: [1, 1, 1, 1] as [number, number, number, number],
      transform: rowMajorTranslation(tx, 0, 0),
    }],
  };
}

describe('Scene.removeInstancedTemplatesForModel — bounding-box teardown (#2073)', () => {
  it('drops the cached world AABB for an instanced-only id once its last occurrence is freed', () => {
    const { scene } = twoModelScene();
    assert.ok(scene.getEntityBoundingBox(10), 'sanity: bbox is cached at upload time');

    scene.removeInstancedTemplatesForModel(3);

    assert.strictEqual(
      scene.getEntityBoundingBox(10), null,
      'id 10 has no geometry left anywhere (instanced-only, its model was freed); a stale bbox must not linger',
    );
  });

  it('keeps the cached world AABB for a MIXED id (also owns flat geometry) — the flat-removal path owns that cache', () => {
    const { scene } = twoModelScene();
    // Simulate id 10 also owning dedicated flat geometry (a mixed id), without
    // going through the full flat-mesh ingestion pipeline — only `meshDataMap`
    // membership is what the mixed/instanced-only discriminator reads.
    (scene as unknown as { meshDataMap: Map<number, unknown[]> }).meshDataMap.set(10, [{}]);
    const before = scene.getEntityBoundingBox(10);
    assert.ok(before);

    scene.removeInstancedTemplatesForModel(3);

    assert.strictEqual(
      scene.getEntityBoundingBox(10), before,
      'mixed id keeps its cached bbox after template teardown; removeMeshesForEntity owns clearing it',
    );
  });

  it('recomputes a SHARED id\'s bounds from its surviving occurrences instead of leaving a stale union', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    // Same express id, two models, non-overlapping world boxes so the stale
    // union is trivially distinguishable from the recomputed (post-removal) box.
    scene.addInstancedShard(device, singleOccShard(42, 0), 3);   // world x in [0, 1]
    scene.addInstancedShard(device, singleOccShard(42, 10), 7);  // world x in [10, 11]
    const unioned = scene.getEntityBoundingBox(42)!;
    assert.strictEqual(unioned.min.x, 0, 'sanity: the union spans both occurrences');
    assert.strictEqual(unioned.max.x, 11);

    scene.removeInstancedTemplatesForModel(3);

    const after = scene.getEntityBoundingBox(42);
    assert.ok(after, 'id 42 is still instanced via model 7');
    assert.strictEqual(after!.min.x, 10, 'bounds must shrink to the surviving occurrence, not keep model 3\'s stale extent');
    assert.strictEqual(after!.max.x, 11);
  });

  it('an instanced-only id whose model was removed is not selectable via the released-geometry bbox raycast', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.addInstancedShard(device, singleOccShard(10, 0), 3);    // world x in [0, 1]
    scene.addInstancedShard(device, singleOccShard(20, 100), 7);  // world x in [100, 101], well clear

    // Sanity: before removal, the ray finds id 10. `addInstancedShard` folds the
    // authored Z-up triangle into the Y-up render frame, so the triangle ends up
    // flat in the y=0 plane, spanning x in [0,1] and z in [-1,0] — the ray must
    // approach along y (not z) to cross that plane, landing at a point strictly
    // inside the triangle (not on an edge, which the intersection test need not
    // resolve).
    const before = scene.raycast({ x: 0.3, y: 5, z: -0.3 }, { x: 0, y: -1, z: 0 });
    assert.strictEqual(before?.expressId, 10);

    scene.removeInstancedTemplatesForModel(3);
    // Post-release, CPU raycast is bbox-only (`raycastBoundingBoxes`), reading
    // straight from `boundingBoxes` — no GPU device needed for this path.
    scene.releaseGeometryData();

    const after = scene.raycast({ x: 0.3, y: 5, z: -0.3 }, { x: 0, y: -1, z: 0 });
    assert.strictEqual(after, null, 'id 10 had geometry only in the removed model; no box should remain to hit');
  });
});
