/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchEntities, foreignLaneIds } from './batch-entities.js';
import { classifyBatch } from './batch-visibility.js';
import { batchEntityIdAnchor, batchHasColorOverride, ENTITY_LANE_ID_SPAN } from './entity-color-table.js';
import { collectShadowOccluders } from './shadow-occluders.js';
import { XRayAlpha } from './xray-alpha.js';
import { batchesHolding } from './batch-highlight.js';
import { pushSplit } from './residency.js';
import type { BatchedMesh } from './types.js';

// #10653: a colour-merged piece with primary id 1 tags some vertices with entity 2. Every
// per-batch decision must cover 2 from batch metadata, without the CPU pieces.

const RED: [number, number, number, number] = [1, 0, 0, 1];
const merged = (laneIds?: number[], extra: Partial<BatchedMesh> = {}): BatchedMesh => ({
  id: 1, colorKey: 'k', vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, color: RED,
  expressIds: [1], modelIndices: [0], ...(laneIds ? { laneIds } : {}), ...extra,
});

describe('colour-merged batches decide by every vertex-lane entity (#10653)', () => {
  it('records the non-primary lane ids of the pieces, sorted and unique', () => {
    const piece = (expressId: number, entityIds?: number[]) => ({ expressId, ...(entityIds ? { entityIds: new Uint32Array(entityIds) } : {}) });
    // A lane id that is also another piece's primary still marks the batch colour-merged (review on #10785):
    // piece 1 hosts entity 2's geometry, so a per-piece split could not keep 2 apart.
    assert.deepEqual(foreignLaneIds([piece(1, [1, 5, 2, 5]), piece(2, [2]), piece(3)]), [2, 5]);
    assert.deepEqual(batchEntities(merged([2], { expressIds: [1, 2], modelIndices: [0, 0] })), [1, 2], 'each entity once');
    assert.equal(foreignLaneIds([piece(1, [1, 1]), piece(3)]), undefined, 'own-id lanes (every in-tree producer) add nothing');
    assert.deepEqual(batchEntities(merged([2])), [1, 2]);
    const plain = merged();
    assert.equal(batchEntities(plain), plain.expressIds, 'no copy without secondary ids');
  });

  it('hiding the secondary while the primary is visible tests the batch per fragment', () => {
    const vis = classifyBatch(merged([2]), new Set([2]), null);
    assert.notEqual(vis, 'all', 'before #10653: all, so entity 2 stayed drawn without the test');
    assert.ok(typeof vis === 'object' && vis.visibleIds.has(1) && !vis.visibleIds.has(2));
  });

  it('hiding the primary, or isolating the secondary, keeps the secondary drawn', () => {
    for (const [hidden, isolated] of [[new Set([1]), null], [null, new Set([2])]] as const) {
      const vis = classifyBatch(merged([2]), hidden, isolated);
      assert.notEqual(vis, 'none', 'before #10653: none, so visible geometry of 2 was dropped');
      assert.ok(typeof vis === 'object' && vis.visibleIds.has(2) && !vis.visibleIds.has(1));
    }
    assert.equal(classifyBatch(merged([2]), new Set([1, 2]), null), 'none');
    assert.equal(classifyBatch(merged(), new Set([2]), null), 'all', 'a batch without secondary ids keeps its behaviour');
  });

  it('shadows cast the same: a hidden secondary marks the batch for the fragment test', () => {
    const batch = merged([2]);
    const [draw] = collectShadowOccluders({ batches: [batch], instanced: [], textured: [] } as unknown as Parameters<typeof collectShadowOccluders>[0], { hiddenIds: new Set([2]) });
    assert.equal(draw?.visibilityFiltered, true);
    assert.equal(collectShadowOccluders({ batches: [batch], instanced: [], textured: [] } as unknown as Parameters<typeof collectShadowOccluders>[0], { hiddenIds: new Set([1]) }).length, 1, 'the secondary still casts');
  });

  it('casts no filtered shadow a cross-page secondary would resolve wrongly (review on #10785)', () => {
    const batch = merged([ENTITY_LANE_ID_SPAN + 2]);
    const sources = { batches: [batch], instanced: [], textured: [] } as unknown as Parameters<typeof collectShadowOccluders>[0];
    assert.deepEqual(collectShadowOccluders(sources, { hiddenIds: new Set([ENTITY_LANE_ID_SPAN + 2]) }), [], 'partly hidden with no anchor: left out');
    assert.equal(collectShadowOccluders(sources, {}).length, 1, 'unfiltered it still casts');
  });

  it('the lane anchor covers the secondary ids, so a cross-page secondary refuses the GPU test', () => {
    assert.notEqual(batchEntityIdAnchor(merged([2])), null);
    assert.equal(batchEntityIdAnchor(merged([ENTITY_LANE_ID_SPAN + 2])), null, 'a lane id on another 2^24 page cannot be resolved from the anchor');
  });

  it('X-Ray fades and override routing see the secondary', () => {
    const xray = new XRayAlpha({ transparencyOverrides: new Map([[2, 0.2]]) }, new Set());
    assert.equal(xray.forBatch(merged([2]), 1), 0.2);
    assert.equal(xray.forBatch(merged(), 1), 1);
    const ghost = new XRayAlpha({ ghostExceptIds: new Set([2]) }, new Set());
    assert.equal(ghost.isGhostBatch(merged([2])), false, 'an excepted secondary keeps the batch out of the ghost stage');
    assert.equal(batchHasColorOverride(merged([2]), new Map([[2, 1]]), 1), true);
  });

  it('the highlight batch search finds a selected secondary, and refuses it under a mixed-model scope', () => {
    const resources = { device: {} as GPUDevice, pipeline: { getBatchSelectionPipeline: () => ({}) } } as unknown as Parameters<typeof batchesHolding>[3];
    const scene = (batch: BatchedMesh) => ({ getBatchedMeshes: () => [batch], requestBatchResidency() {}, getTexturedMeshes: () => [], getPickGeometryRevision: () => 0 });
    const held = batchesHolding(scene(merged([2])), new Set([2]), 0, resources);
    assert.ok(held.found.has(2) && !held.blocked.has(2) && held.batches.size === 1);
    const mixed = batchesHolding(scene(merged([2], { expressIds: [1, 3], modelIndices: [0, 1] })), new Set([2]), 0, resources);
    assert.ok(mixed.blocked.has(2), 'the lane cannot tell which model the secondary belongs to');
  });

  it('a cold colour-merged batch draws whole and never fetches pieces for a split it cannot make', () => {
    let fetched = 0;
    const requests = { pushSplit: () => { throw new Error('asked to split'); }, wantsSplit: () => true } as unknown as Parameters<typeof pushSplit>[0];
    const scene = { requestBatchPieces: () => { fetched++; return true; } } as unknown as Parameters<typeof pushSplit>[1];
    assert.equal(pushSplit(requests, scene, merged([2], { gpuResident: false }), false, new Set([1, 2])), 'whole');
    assert.equal(fetched, 0);
  });
});
