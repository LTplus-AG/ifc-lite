/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchesHolding } from './batch-highlight.js';
import type { BatchedMesh } from './types.js';

// The entity -> batch reverse index must choose exactly what the full scan chooses.

const scanResources = { device: {} as GPUDevice, pipeline: { getBatchSelectionPipeline: () => ({}) } } as unknown as Parameters<typeof batchesHolding>[3];
const indexedResources = { ...scanResources, entityIndex: true };

function campus(batches: number, perBatch: number): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  let id = 1;
  for (let b = 0; b < batches; b++) {
    const expressIds: number[] = []; const modelIndices: number[] = [];
    for (let e = 0; e < perBatch; e++) { expressIds.push(id++); modelIndices.push(b % 7 === 0 ? 1 : 0); }
    // a few entities split across two batches (pieces of different colours)
    if (b > 0 && b % 5 === 0) { expressIds.push(id - perBatch - 3); modelIndices.push(0); }
    out.push({ id: b + 1, colorKey: `k${b}`, vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, color: [1, 1, 1, 1],
      expressIds, modelIndices, ...(b % 11 === 0 ? { laneIds: [id + 1_000_000] } : {}) });
  }
  return out;
}

const scene = (list: BatchedMesh[]) => ({ getBatchedMeshes: () => list, requestBatchResidency() {}, getTexturedMeshes: () => [], getPickGeometryRevision: () => 0 });
const shape = (r: ReturnType<typeof batchesHolding>) => ({ batches: [...r.batches.values()], found: [...r.found].sort((a, b) => a - b), blocked: [...r.blocked].sort((a, b) => a - b) });

describe('highlight entity -> batch index', () => {
  it('matches the full scan for single ids, storeys, lane ids and model scopes', () => {
    const list = campus(2000, 40);
    const s = scene(list);
    const cases: [Set<number>, number | undefined][] = [
      [new Set([5]), undefined], [new Set([5]), 0], [new Set([41, 42, 43, 9999999]), 1],
      [new Set(Array.from({ length: 5000 }, (_, i) => 1 + i * 13)), 0],
      [new Set([list[11]!.laneIds![0]!, list[22]!.laneIds![0]!]), 0],
      [new Set([list[0]!.expressIds[3]!]), 0], // a model-1 batch under a model-0 scope: blocked
    ];
    for (const [ids, model] of cases) {
      const scan = shape(batchesHolding(s, ids, model, scanResources));
      const indexed = shape(batchesHolding(s, ids, model, indexedResources));
      assert.deepEqual(indexed, scan);
    }
  });

  it('rebuilds the index when the batch list changes', () => {
    const list = campus(50, 4);
    const s = scene(list);
    const id = list[3]!.expressIds[0]!;
    assert.deepEqual(shape(batchesHolding(s, new Set([id]), 0, indexedResources)).found, [id]);
    list.push({ ...list[3]!, id: 999, expressIds: [777777], modelIndices: [0] });
    assert.deepEqual(shape(batchesHolding(s, new Set([777777]), 0, indexedResources)).found, [777777]);
  });

  it('rebuilds when a candidate batch was swapped in place without a revision bump', () => {
    const list = campus(50, 4);
    const s = scene(list);
    const id = list[3]!.expressIds[0]!;
    assert.deepEqual(shape(batchesHolding(s, new Set([id]), 0, indexedResources)).found, [id]);
    list[3] = { ...list[3]!, id: 1000, expressIds: [555555], modelIndices: [0] }; // in place, same length and revision
    assert.deepEqual(shape(batchesHolding(s, new Set([id]), 0, indexedResources)), shape(batchesHolding(s, new Set([id]), 0, scanResources)));
    assert.deepEqual(shape(batchesHolding(s, new Set([555555]), 0, indexedResources)).found, [555555]);
  });

  it('sees an id swapped in at an index no query has touched, and adopts same-id restores', () => {
    const list = campus(50, 4);
    const s = scene(list);
    batchesHolding(s, new Set([list[0]!.expressIds[0]!]), 0, indexedResources); // build
    list[7] = { ...list[7]!, id: 2000, expressIds: [777001], modelIndices: [0] };
    assert.deepEqual(shape(batchesHolding(s, new Set([777001]), 0, indexedResources)).found, [777001]);
    const restored = { ...list[9]!, id: 3000 }; // same ids, new object
    list[9] = restored;
    const id = restored.expressIds[1]!;
    assert.deepEqual(shape(batchesHolding(s, new Set([id]), 0, indexedResources)), shape(batchesHolding(s, new Set([id]), 0, scanResources)));
  });
});
