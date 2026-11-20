/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drawing's geometry as a replayable `DrawingMeshSource` (#10264).
 *
 * Resident (the default, nothing released): the drawing's flat meshes as one
 * batch, exactly the list it always cut, then each GPU-instanced entity's
 * occurrences, one entity at a time, materialized by the scene.
 *
 * Released (the CPU arrays of a model were freed, today only by the TEST-ONLY
 * release): a model whose flat meshes are not all resident streams them from
 * its backing chunk by chunk, re-indexed and placed like the merged list; and
 * once the scene's CPU templates are gone, instanced occurrences come from the
 * backed shards, materialized by the renderer's own upload preparation in
 * bounded groups. Each batch is discarded when the generator advances.
 *
 * Fences: a model's backing is pinned when the drawing starts and must stay
 * current and complete; the reader throws for a generation replaced while it
 * was read, and a replay that yields a different number of meshes than the
 * model holds throws. Any of these rejects the drawing (`GeometryUnavailableError`
 * or `StaleGeometryGenerationError`), never a partial or empty result.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { DrawingMeshSource } from '@ifc-lite/drawing-2d';
import type { DrawingMeshFilter } from './drawing-mesh-filter';
import { placedMesh } from '@/lib/model-placement/placed-geometry';
import type { Translation } from '@/lib/model-placement/translation';
import { GeometryUnavailableError, meshIsResident } from '@/lib/geometry-backing/geometry-readback';
import { meshGeometryCounts } from '@/lib/released-mesh-provenance';
import type { ModelGeometryBacking } from '@/lib/geometry-backing/geometry-backing-registry';
import { materializeBackedOccurrences } from './drawing-instanced-readback';

/** The scene's resident instanced occurrences (already in the placed frame). */
export interface InstancedScene {
  getInstancedEntityIds(): Iterable<number>;
  getInstancedMeshDataPieces(expressId: number): MeshData[] | undefined;
}

export interface DrawingGeometryDeps {
  /** Owning model of a global id; undefined for an id no model owns. */
  modelOf(globalId: number): string | undefined;
  /** The shown models, whose geometry belongs in the drawing. */
  visibleModels: readonly string[];
  modelIndexOf(modelId: string): number;
  /** The model's displayed placement, applied to its read-back geometry. */
  translationFor(modelId: string): Translation;
  /** IFC class of an instanced occurrence's entity, which its pieces do not carry. */
  typeOf(globalId: number): string | undefined;
  /** Resident occurrences; null when the scene has none or released them. */
  scene: InstancedScene | null;
  /** Whether instanced occurrences must come from the backings (scene CPU templates released). */
  instancedReleased: boolean;
  /** Whether the model ever streamed instanced shards (the store's record, independent of any backing). */
  hasInstanced(modelId: string): boolean;
  /** Instanced entity ids the scene still lists after releasing their CPU templates (opaque, uploaded ones), if it does. */
  listedInstanced?: () => Iterable<number>;
  /** The model's current backing generation, if any. */
  backing(modelId: string): ModelGeometryBacking | undefined;
  /** False once a newer drawing request superseded this one: the next batch aborts the read. */
  isCurrent(): boolean;
}

export interface DrawingSourceOptions {
  /** Include GPU-instanced occurrences (the drawing does; storey floor scoping does not). */
  instanced: boolean;
}

interface Run { modelId: string | undefined; modelIndex: number; meshes: MeshData[]; resident: boolean }

function usableBacking(backing: ModelGeometryBacking | undefined, modelId: string): ModelGeometryBacking {
  if (!backing || !backing.isCurrent) throw new GeometryUnavailableError(`Model ${modelId} has no current geometry backing; its released geometry cannot be drawn`);
  if (!backing.isComplete) throw new GeometryUnavailableError(`Model ${modelId}'s geometry backing is incomplete; its released geometry cannot be drawn`);
  return backing;
}

/** What makes a backed mesh the store's mesh at the same position: entity, item, class, material and size. */
function meshIdentity(mesh: MeshData): string {
  const { vertices, triangles } = meshGeometryCounts(mesh);
  return `${mesh.expressId}|${mesh.geometryItemId ?? '-'}|${mesh.geometryClass ?? 0}|${mesh.materialId ?? '-'}|${vertices}|${triangles}`;
}

const withIndex = (mesh: MeshData, modelIndex: number): MeshData =>
  mesh.modelIndex === modelIndex ? mesh : { ...mesh, modelIndex };

export class DrawingGeometry {
  /** Contiguous same-model runs of the merged list, in its order. */
  private readonly runs: Run[] = [];
  private readonly pinned = new Map<string, ModelGeometryBacking>();
  /** Each model's flat meshes in list order, which its backing must reproduce one for one. */
  private readonly modelMeshes = new Map<string, MeshData[]>();
  private readonly abort = new AbortController();
  /** Whether any geometry must be read back rather than taken from memory. */
  readonly released: boolean;

  constructor(private readonly meshes: readonly MeshData[], private readonly deps: DrawingGeometryDeps) {
    for (const mesh of meshes) {
      const modelId = deps.modelOf(mesh.expressId);
      let run = this.runs[this.runs.length - 1];
      if (!run || run.modelId !== modelId) {
        run = { modelId, modelIndex: mesh.modelIndex ?? 0, meshes: [], resident: true };
        this.runs.push(run);
      }
      run.meshes.push(mesh);
      if (modelId !== undefined) {
        const own = this.modelMeshes.get(modelId);
        if (own) own.push(mesh); else this.modelMeshes.set(modelId, [mesh]);
      }
    }
    const releasedModels = new Set<string>();
    for (const run of this.runs) {
      if (run.meshes.every(meshIsResident)) continue;
      if (run.modelId === undefined) throw new GeometryUnavailableError('Released geometry of no known model cannot be drawn');
      releasedModels.add(run.modelId);
    }
    for (const run of this.runs) if (run.modelId !== undefined && releasedModels.has(run.modelId)) run.resident = false;
    if (deps.instancedReleased) for (const modelId of deps.visibleModels) releasedModels.add(modelId);
    // Pin every generation this drawing reads now: a later generation must
    // never answer a pass that started on this one.
    for (const modelId of releasedModels) this.pinned.set(modelId, usableBacking(deps.backing(modelId), modelId));
    // Instanced occurrences come only from the backing once the scene let go of
    // them: a model that streamed shards but whose backing holds none is incomplete.
    if (deps.instancedReleased) this.checkInstancedBacked();
    this.released = releasedModels.size > 0;
  }

  /** Every instanced entity the model streamed must be held by its pinned backing's shards. */
  private checkInstancedBacked(): void {
    const { deps } = this;
    for (const modelId of deps.visibleModels) {
      if (deps.hasInstanced(modelId) && this.pinned.get(modelId)?.directory.shards.length === 0) {
        throw new GeometryUnavailableError(`Model ${modelId} streamed instanced geometry its backing does not hold`);
      }
    }
    for (const id of deps.listedInstanced?.() ?? []) {
      const modelId = deps.modelOf(id);
      if (modelId === undefined || !deps.visibleModels.includes(modelId)) continue;
      if (this.pinned.get(modelId)?.directory.shardsOf(id).length) continue;
      throw new GeometryUnavailableError(`Instanced entity ${id} of model ${modelId} is in no backed shard`);
    }
  }

  /** Abort the reads of a superseded request before its next batch. */
  private fence(): AbortSignal {
    if (!this.abort.signal.aborted && !this.deps.isCurrent()) {
      this.abort.abort(new DOMException('A newer drawing request superseded this one', 'AbortError'));
    }
    this.abort.signal.throwIfAborted();
    return this.abort.signal;
  }

  private owned(globalId: number, modelId: string): void {
    if (this.deps.modelOf(globalId) !== modelId) {
      throw new GeometryUnavailableError(`Backed id ${globalId} of model ${modelId} is not in its global id range`);
    }
  }

  private occurrenceMeta(globalId: number) {
    return { expressId: globalId, ifcType: this.deps.typeOf(globalId) };
  }

  /** Whether `keep` passes nothing at all; reads metadata only, never geometry. */
  isEmpty(keep: DrawingMeshFilter, options: DrawingSourceOptions): boolean {
    if (this.meshes.some(keep)) return false;
    if (!options.instanced) return true;
    for (const id of this.instancedIds()) if (keep(this.occurrenceMeta(id))) return false;
    return true;
  }

  private *instancedIds(): Iterable<number> {
    const { deps } = this;
    if (!deps.instancedReleased) {
      for (const id of deps.scene?.getInstancedEntityIds() ?? []) {
        const modelId = deps.modelOf(id);
        if (modelId !== undefined && deps.visibleModels.includes(modelId)) yield id;
      }
      return;
    }
    // The scene's list is what both routes draw (opaque occurrences only); the
    // shard directory also names translucent occurrences no route materializes.
    if (deps.listedInstanced) {
      for (const id of deps.listedInstanced()) {
        const modelId = deps.modelOf(id);
        if (modelId !== undefined && deps.visibleModels.includes(modelId) && this.pinned.has(modelId)) yield id;
      }
      return;
    }
    for (const modelId of deps.visibleModels) {
      const backing = this.pinned.get(modelId);
      if (!backing) continue;
      for (const shard of backing.directory.shards) yield* shard.entities;
    }
  }

  source(keep: DrawingMeshFilter, options: DrawingSourceOptions): DrawingMeshSource {
    return { pass: () => this.pass(keep, options) };
  }

  private async *pass(keep: DrawingMeshFilter, options: DrawingSourceOptions): AsyncGenerator<readonly MeshData[]> {
    const { deps } = this;
    this.fence();
    if (!this.released) {
      // The resident drawing, unchanged: the whole kept list in one batch.
      const kept = this.meshes.filter(keep);
      if (kept.length > 0) yield kept;
    } else {
      const streamed = new Set<string>();
      for (const run of this.runs) {
        this.fence();
        if (run.resident || run.modelId === undefined) {
          const kept = run.meshes.filter(keep);
          if (kept.length > 0) yield kept;
        } else if (!streamed.has(run.modelId)) {
          streamed.add(run.modelId);
          yield* this.backedFlat(run.modelId, run.modelIndex, keep);
        }
      }
    }
    if (options.instanced) yield* this.instanced(keep);
  }

  private async *backedFlat(modelId: string, modelIndex: number, keep: DrawingMeshFilter): AsyncGenerator<readonly MeshData[]> {
    const backing = usableBacking(this.pinned.get(modelId), modelId);
    const translation = this.deps.translationFor(modelId);
    const expected = this.modelMeshes.get(modelId) ?? [];
    let read = 0;
    for await (const chunk of backing.reader.meshes({ signal: this.fence() })) {
      this.fence();
      const kept: MeshData[] = [];
      for (const mesh of chunk) {
        // Backed meshes carry global ids, as the store list does (federation
        // re-homes them at ingest); one that resolves elsewhere is not this model's.
        this.owned(mesh.expressId, modelId);
        // The backing mirrors the store list in order: the mesh at each position
        // must be that list's mesh, not merely one of the model's.
        const current = expected[read++];
        if (!current || meshIdentity(current) !== meshIdentity(mesh)) {
          throw new GeometryUnavailableError(`Model ${modelId}'s backed mesh ${read - 1} (#${mesh.expressId}) is not its current mesh${current ? ` #${current.expressId}` : ''}`);
        }
        if (!keep(mesh)) continue;
        kept.push(placedMesh(withIndex(mesh, modelIndex), translation));
      }
      if (kept.length > 0) yield kept;
    }
    // A backing that does not hold exactly the model's meshes is not its geometry.
    if (read !== expected.length) {
      throw new GeometryUnavailableError(`Model ${modelId}'s backing holds ${read} meshes, the model ${expected.length}`);
    }
  }

  private async *instanced(keep: DrawingMeshFilter): AsyncGenerator<readonly MeshData[]> {
    const { deps } = this;
    if (!deps.instancedReleased) {
      for (const id of this.instancedIds()) {
        this.fence();
        const meta = this.occurrenceMeta(id);
        if (!keep(meta)) continue;
        const pieces = deps.scene?.getInstancedMeshDataPieces(id);
        // Listed but not materializable (CPU templates gone): never draw without it.
        if (!pieces?.length) throw new GeometryUnavailableError(`Instanced entity ${id} has no resident occurrence geometry`);
        yield pieces.map((piece) => ({ ...piece, ifcType: meta.ifcType }));
      }
      return;
    }
    for (const modelId of deps.visibleModels) {
      const backing = this.pinned.get(modelId);
      if (!backing) continue;
      const translation = deps.translationFor(modelId);
      const wanted = (id: number) => keep(this.occurrenceMeta(id));
      for await (const group of materializeBackedOccurrences(usableBacking(backing, modelId), deps.modelIndexOf(modelId), wanted,
        { signal: this.fence() })) {
        this.fence();
        for (const piece of group) this.owned(piece.expressId, modelId);
        yield group.map((piece) => placedMesh({ ...piece, ifcType: deps.typeOf(piece.expressId) }, translation));
      }
    }
  }
}
