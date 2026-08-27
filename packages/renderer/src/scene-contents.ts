/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SceneContents` — the scene surface `Renderer.getScene()` hands across the
 * package boundary.
 *
 * WHY THIS EXISTS: `getScene()` used to return the `Scene` class itself. `Scene`
 * is 4400+ lines, so a consumer of `@ifc-lite/renderer` had to learn `Renderer`
 * PLUS the whole of `Scene` — and every method added to `Scene` silently became
 * published API. This interface freezes that leak at its measured width.
 *
 * HOW THE MEMBER LIST WAS CHOSEN: it is not a design sketch, it is a
 * measurement. Every `renderer.getScene()` call site in `apps/viewer` and
 * `apps/viewer-embed` was resolved with the TypeScript checker and the returned
 * value followed through locals, class fields, object-literal properties,
 * parameters and function returns until it was dereferenced; the members below
 * are exactly the ones something outside `packages/renderer/src` reaches for.
 *
 * ADDING A MEMBER IS A DECISION, NOT A DETAIL. A new entry here is a new
 * published API for `@ifc-lite/renderer` and cannot be taken back without a
 * major bump. Add one when a caller genuinely needs it — not because `Scene`
 * already has it.
 *
 * `Scene` is NOT declared `implements SceneContents`: an `implements` clause
 * would let the class's own surface drift wider without the interface noticing,
 * which is the thing this file exists to stop. The check that the class still
 * satisfies this shape is the `return this.scene` in `Renderer.getScene()`.
 *
 * Be precise about what that catches, because it is less than it looks: a
 * REMOVED member or an incompatible RETURN type. It does not catch a parameter
 * turning required, because assignability checks arity rather than optionality,
 * and method parameters stay bivariant even under `strict`. Five members here
 * declare optional parameters (`getMeshDataPieces`, `appendToBatches`,
 * `finalizeStreamingAsync`, `processResidencyRestores`, `addInstancedShard`)
 * and are unguarded in that direction.
 *
 * `GPUDevice` and `RenderPipeline` stay concrete in these signatures on
 * purpose. Callers never reach into either one; they take the handles from
 * `getGPUDevice()` / `getPipeline()` and hand them straight back to the upload
 * methods here. Replacing them with narrower stand-ins would only be honest if
 * `Scene`'s own signatures were narrowed too, which is a different change.
 */

import type { Mesh, BatchedMesh } from './types.js';
import type { MeshData, DecodedInstancedShard } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BoundingBox } from './scene-raycaster.js';
import type { ResidentGpuBytes } from './render-stats.js';
import type { ColdGeometryProvider } from './residency.js';
import type { SpatialChunkingConfig } from './chunk-grid.js';

/** The measured external scene surface. See the module doc before widening. */
export interface SceneContents {
  // ─── Streaming queue and GPU upload ──────────────────────────────────
  queueMeshes(meshes: MeshData[]): void;
  hasQueuedMeshes(): boolean;
  flushPending(device: GPUDevice, pipeline: RenderPipeline): boolean;
  appendToBatches(
    meshDataArray: MeshData[],
    device: GPUDevice,
    pipeline: RenderPipeline,
    isStreaming?: boolean,
  ): void;
  hasPendingBatches(): boolean;
  rebuildPendingBatches(device: GPUDevice, pipeline: RenderPipeline): void;
  hasStreamingFragments(): boolean;
  finalizeStreaming(device: GPUDevice, pipeline: RenderPipeline): void;
  finalizeStreamingAsync(
    device: GPUDevice,
    pipeline: RenderPipeline,
    budgetMs?: number,
  ): Promise<void>;
  isFinalizeInProgress(): boolean;
  setEphemeralStreamingMode(enabled: boolean): void;
  isEphemeralStreaming(): boolean;
  finishEphemeralStreaming(): void;

  // ─── Geometry read-back ──────────────────────────────────────────────
  getMeshes(): Mesh[];
  getBatchedMeshes(): BatchedMesh[];
  getMeshDataPieces(expressId: number, modelIndex?: number): MeshData[] | undefined;
  getAllMeshDataExpressIds(): number[];
  getBounds(): {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } | null;
  getEntityBoundingBox(expressId: number): BoundingBox | null;

  // ─── Instanced geometry ──────────────────────────────────────────────
  addInstancedShard(
    device: GPUDevice,
    shard: DecodedInstancedShard,
    modelIndex?: number,
  ): void;
  getAllInstancedMeshData(): MeshData[];
  getInstancedMeshDataPieces(expressId: number): MeshData[] | undefined;
  getInstancedEntityBounds(expressId: number): BoundingBox | null;
  getInstancedEntityCount(): number;
  getInstancedEntityIds(): IterableIterator<number>;
  getInstancedModelIndices(): number[];
  removeInstancedTemplatesForModel(modelIndex: number): number;
  setInstancedVisible(visible: boolean): void;

  // ─── Authoring mutations ─────────────────────────────────────────────
  removeMeshesForEntities(expressIds: Iterable<number>): number;
  translateMeshesForEntities(updates: Map<number, [number, number, number]>): number;
  rotateMeshesForEntities(
    updates: Map<number, { angle: number; pivot: [number, number, number] }>,
  ): number;

  // ─── Colour overrides ────────────────────────────────────────────────
  setColorOverrides(
    overrides: Map<number, [number, number, number, number]>,
    device: GPUDevice,
    pipeline: RenderPipeline,
  ): void;
  clearColorOverrides(): void;
  updateMeshColors(
    updates: Map<number, [number, number, number, number]>,
    device: GPUDevice,
    pipeline: RenderPipeline,
  ): void;

  // ─── Residency and chunking ──────────────────────────────────────────
  setSpatialChunking(config: SpatialChunkingConfig | null): void;
  setLodBuildsEnabled(enabled: boolean): void;
  setHostResidencyBudget(bytes: number | null): void;
  setGpuResidencyBudget(bytes: number | null): void;
  setColdGeometryProvider(provider: ColdGeometryProvider | null): void;
  hasResidencyRestoreWork(): boolean;
  processResidencyRestores(
    device: GPUDevice,
    pipeline: RenderPipeline,
    budgetMs?: number,
  ): number;
  drainColdTier(): Promise<void>;
  getResidentCpuBytes(): number;
  getResidentGpuBytes(): ResidentGpuBytes;

  // ─── Teardown ────────────────────────────────────────────────────────
  clearFlatGeometry(): void;
  clear(): void;
}
