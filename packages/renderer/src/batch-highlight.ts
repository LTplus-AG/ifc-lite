/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection and hover highlight drawn from the colour batches (#10264 S3).
 *
 * A selected entity used to be highlighted by GPU copies of its pieces, built
 * from the CPU copy of the geometry (`selection-hydration.ts`). Here the
 * colour batches that hold it are drawn again, whole, from their own GPU
 * buffers, and the fragment stage keeps only the highlighted entities
 * (`entity-highlight-table.ts`). The batch's vertices are the ones the colour
 * pass drew, so the highlight is coincident with them by construction.
 *
 * An entity is drawn this way only when every batch holding it can be: GPU
 * resident, with a lane anchor, and with a highlight pipeline for its vertex
 * layout. An entity that also shares its id with another federated model's
 * entry in a batch, while the selection is scoped to one model, cannot be
 * told apart by the lane and is left out too. Such entities keep the copies
 * (when their CPU geometry is in memory), so no entity is ever highlighted in
 * part: never one batch of it here and the rest missing.
 *
 * Records are non-owning: they borrow the batch's buffers and own only a
 * mesh uniform slot, like `textured-selection.ts`. They are re-checked every
 * frame against the scene's batch list and residency, since an eviction or a
 * rebuild destroys or replaces the buffers they borrow.
 */

import { batchEntityIdAnchor } from './entity-color-table.js';
import { MathUtils } from './math.js';
import { meshUniformArena, stageMeshUniforms, type MeshUniformSlot } from './mesh-uniform-arena.js';
import type { RenderPipeline } from './pipeline.js';
import type { Scene } from './scene.js';
import type { BatchedMesh, Mesh } from './types.js';

export type BatchHighlightScene = Pick<Scene, 'getBatchedMeshes' | 'requestBatchResidency'>;

export interface BatchHighlightResources {
  device: GPUDevice;
  pipeline: Pick<RenderPipeline, 'getUniformBufferSize' | 'getBindGroupLayout' | 'getBatchSelectionPipeline'>;
}

/** What {@link BatchHighlight.sync} decided. */
export interface BatchHighlightResult {
  /** The visible selected ids the batch draws highlight: these need no copies. */
  covered: ReadonlySet<number>;
  /** One record per batch holding a covered id. */
  draws: readonly Mesh[];
}

const sources = new WeakMap<Mesh, { batch: BatchedMesh; slot: MeshUniformSlot }>();

/** The colour batch a highlight record draws, or undefined for any other mesh. */
export function highlightBatchOf(mesh: Mesh): BatchedMesh | undefined {
  return sources.get(mesh)?.batch;
}

/** Stage a record's uniforms into its own slot; false for a mesh that is not a record. */
export function stageBatchHighlight(mesh: Mesh, uniforms: Float32Array): boolean {
  const source = sources.get(mesh);
  if (!source) return false;
  stageMeshUniforms(source.slot, uniforms);
  return true;
}

/** Whether a batch's own buffers can draw the highlight this frame. */
function drawable(batch: BatchedMesh, resources: BatchHighlightResources): boolean {
  return batch.gpuResident !== false && batchEntityIdAnchor(batch) !== null
    && resources.pipeline.getBatchSelectionPipeline(batch.quantized !== undefined) !== null;
}

/**
 * The batches holding `ids` (in `modelIndex`, undefined = every model), and
 * the ids that cannot be drawn from them. A batch that cannot draw is asked
 * back into residency when that is why.
 */
export function batchesHolding(
  scene: BatchHighlightScene,
  ids: ReadonlySet<number>,
  modelIndex: number | undefined,
  resources: BatchHighlightResources,
): { batches: Map<BatchedMesh, number>; evicted: Map<BatchedMesh, number>; blocked: Set<number>; found: Set<number> } {
  const batches = new Map<BatchedMesh, number>();
  const evicted = new Map<BatchedMesh, number>();
  const blocked = new Set<number>();
  const found = new Set<number>();
  const list = scene.getBatchedMeshes();
  for (let index = 0; index < list.length; index++) {
    const batch = list[index]!;
    const models = batch.modelIndices;
    let holds = false;
    for (let entry = 0; entry < batch.expressIds.length; entry++) {
      const id = batch.expressIds[entry]!;
      if (!ids.has(id)) continue;
      const model = models?.[entry];
      // Another model's entity under the same id: the lane cannot tell them apart.
      if (modelIndex !== undefined && model !== undefined && model !== modelIndex) { blocked.add(id); continue; }
      found.add(id);
      holds = true;
    }
    if (!holds) continue;
    if (drawable(batch, resources)) { batches.set(batch, index); continue; }
    if (batch.gpuResident === false) { scene.requestBatchResidency(batch); evicted.set(batch, index); }
    for (const id of batch.expressIds) if (ids.has(id)) blocked.add(id);
  }
  return { batches, evicted, blocked, found };
}

/**
 * The batches a choice borrows, and the evicted ones it waits for, where each
 * sat in the scene list. A choice is stale once the list changed, a borrowed
 * batch was evicted or swapped in place, or a waited-for one came back.
 * O(batches held) on an unchanged frame.
 */
class BatchWatch {
  private drawn = new Map<BatchedMesh, number>();
  private waiting = new Map<BatchedMesh, number>();
  private list: readonly BatchedMesh[] | null = null;
  private listLength = 0;

  set(scene: BatchHighlightScene, drawn: Map<BatchedMesh, number>, waiting: Map<BatchedMesh, number>): void {
    this.drawn = drawn; this.waiting = waiting;
    this.list = scene.getBatchedMeshes(); this.listLength = this.list.length;
  }

  stale(scene: BatchHighlightScene): boolean {
    if (this.drawn.size === 0 && this.waiting.size === 0) return false;
    const list = scene.getBatchedMeshes();
    if (list !== this.list || list.length !== this.listLength) return true;
    for (const [batch, index] of this.drawn) if (batch.gpuResident === false || list[index] !== batch) return true;
    for (const [batch, index] of this.waiting) if (batch.gpuResident !== false || list[index] !== batch) return true;
    return false;
  }

  has(batch: BatchedMesh): boolean { return this.drawn.has(batch); }
  clear(): void { this.drawn = new Map(); this.waiting = new Map(); this.list = null; this.listLength = 0; }
}

/** The selection's batch draws, kept between frames. */
export class BatchHighlight {
  private records = new Map<BatchedMesh, Mesh>();
  private readonly watch = new BatchWatch();
  private device: GPUDevice | undefined;

  /**
   * Choose the batches that highlight `visible` (minus `exact`, the ids that
   * keep their copies, e.g. an item filter), and refresh their records.
   */
  sync(
    scene: BatchHighlightScene,
    visible: ReadonlySet<number>,
    modelIndex: number | undefined,
    exact: ReadonlySet<number>,
    resources: BatchHighlightResources,
  ): BatchHighlightResult {
    if (this.device !== resources.device) { this.clear(); this.device = resources.device; }
    const wanted = exact.size === 0 ? visible : new Set([...visible].filter((id) => !exact.has(id)));
    const { batches, evicted, blocked, found } = batchesHolding(scene, wanted, modelIndex, resources);
    const covered = new Set<number>();
    for (const id of found) if (!blocked.has(id)) covered.add(id);
    const draws: Mesh[] = [];
    const drawn = new Map<BatchedMesh, number>();
    for (const [batch, index] of batches) {
      if (!batch.expressIds.some((id) => covered.has(id))) continue;
      draws.push(this.record(batch, resources));
      drawn.set(batch, index);
    }
    this.watch.set(scene, drawn, evicted);
    for (const [batch, mesh] of this.records) {
      if (this.watch.has(batch)) continue;
      sources.get(mesh)!.slot.release();
      sources.delete(mesh);
      this.records.delete(batch);
    }
    return { covered, draws };
  }

  /** Whether a record borrows buffers that are gone or replaced: sync again before drawing. */
  stale(scene: BatchHighlightScene): boolean { return this.watch.stale(scene); }

  private record(batch: BatchedMesh, resources: BatchHighlightResources): Mesh {
    let mesh = this.records.get(batch);
    if (!mesh) {
      const slot = meshUniformArena(resources.device, resources.pipeline.getUniformBufferSize()).allocate();
      try {
        const bindGroup = resources.device.createBindGroup({ layout: resources.pipeline.getBindGroupLayout(),
          entries: [{ binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } }] });
        const origin: [number, number, number] = batch.origin ? [...batch.origin] : [0, 0, 0];
        const transform = MathUtils.identity();
        transform.m[12] = origin[0]; transform.m[13] = origin[1]; transform.m[14] = origin[2];
        // The lane anchor stands as its id: the shader rebuilds full ids from it.
        mesh = { expressId: batchEntityIdAnchor(batch)!, vertexBuffer: batch.vertexBuffer, indexBuffer: batch.indexBuffer,
          indexCount: batch.indexCount, color: batch.color, transform, rteOrigin: origin, uniformBuffer: slot.buffer, bindGroup,
          ...(batch.finish ? { finish: batch.finish } : {}) };
      } catch (error) { slot.release(); throw error; }
      sources.set(mesh, { batch, slot });
      this.records.set(batch, mesh);
    }
    return mesh;
  }

  /** Release every record's uniform slot. The batches' own buffers are never freed here. */
  clear(): void {
    for (const mesh of this.records.values()) { sources.get(mesh)?.slot.release(); sources.delete(mesh); }
    this.records.clear();
    this.watch.clear();
  }
}

/**
 * The batches that draw the hover outline of one entity, re-chosen only when
 * the hovered (model, id) or the batches change. Null when the entity cannot
 * be drawn from batches: the caller then uses copies of its pieces.
 */
export class HoverBatches {
  private key: string | null = null;
  private batches: readonly BatchedMesh[] | null = null;
  private list: readonly BatchedMesh[] | null = null;
  private readonly watch = new BatchWatch();

  resolve(scene: BatchHighlightScene, id: number, modelIndex: number | undefined, resources: BatchHighlightResources): readonly BatchedMesh[] | null {
    // The list itself is in the key: an entity not yet in any batch is found once its batch arrives.
    const list = scene.getBatchedMeshes();
    const key = `${modelIndex ?? 'any'}:${id}:${list.length}`;
    if (key === this.key && list === this.list && !this.watch.stale(scene)) return this.batches;
    this.list = list;
    const { batches, evicted, blocked, found } = batchesHolding(scene, new Set([id]), modelIndex, resources);
    this.batches = found.has(id) && !blocked.has(id) ? [...batches.keys()] : null;
    this.watch.set(scene, this.batches ? batches : new Map(), evicted);
    this.key = key;
    return this.batches;
  }

  clear(): void { this.key = null; this.batches = null; this.list = null; this.watch.clear(); }
}
