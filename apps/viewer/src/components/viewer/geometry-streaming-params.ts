/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

export interface UseGeometryStreamingParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  /** Replacement-device publication; retries arrivals skipped during a loss. */
  gpuRecoveryEpoch?: number;
  geometry: MeshData[] | null;
  /** Full loaded source geometry, including hidden models, for retained appearance history. */
  appearanceSourceGeometry?: readonly MeshData[];
  /** Monotonic counter — triggers the streaming effect even when the geometry
   *  array reference is stable (incremental filtering reuses the same array). */
  geometryVersion?: number;
  /** Existing filtered meshes changed; same-count replacements need a rebuild (#7047). */
  geometryReplacementVersion?: number;
  /**
   * Monotonic counter that bumps whenever existing mesh data has been mutated
   * in place (e.g. realignFederation rewrote vertex positions). Length-based
   * triggers can't detect in-place mutation, so when this bumps we treat the
   * incoming `geometry` as a fresh replacement and re-upload it to the GPU.
   */
  geometryContentVersion?: number;
  coordinateInfo?: CoordinateInfo;
  isStreaming: boolean;
  /** Number of loaded models. When this increases (a model was added to the
   *  federation) the camera must refit to the new combined bounds — otherwise
   *  it stays framed on the first model and the newly-added one is off-screen. */
  modelCount?: number;
  geometryBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
  pendingMeshColorUpdates: Map<number, [number, number, number, number]> | null;
  pendingColorUpdates: Map<number, [number, number, number, number]> | null;
  /**
   * Authoring actions (split, delete) push globalIds here; the
   * streaming loop drains them via `scene.removeMeshesForEntities`
   * so tombstoned IFC entities disappear from the rendered scene
   * (rather than just being hidden via `hiddenIds`). Cleared by
   * the hook after the drain.
   */
  pendingMeshRemovals: Set<number> | null;
  /**
   * Per-entity translations queued by authoring actions (gizmo
   * drag, numeric move). Drained by the streaming hook into
   * `scene.translateMeshesForEntities` so the visible mesh
   * follows the IFC coordinate mutation on the next frame.
   */
  pendingMeshTranslations: Map<number, [number, number, number]> | null;
  /**
   * Per-entity yaw rotations queued by authoring actions or a collab
   * peer's placement edit. Drained into `scene.rotateMeshesForEntities`.
   */
  pendingMeshRotations: Map<number, { angle: number; pivot: [number, number, number] }> | null;
  /**
   * Emit-both GPU-instancing: raw IFNS shard bytes from the geometry worker,
   * tagged with the owning model's id, drained here via
   * `scene.addInstancedShard` (decode + upload as instanced templates).
   * Cleared after each drain. Inert until the wasm exposes
   * processGeometryBatchInstanced.
   */
  pendingInstancedShards: Array<{ modelId: string; bytes: ArrayBuffer }> | null;
  /** Current absolute renderer-Y lifts, keyed by global entity id. New arrivals
   * inherit them before upload; later level changes still use pending deltas. */
  currentLevelY?: ReadonlyMap<number, number>;
  /**
   * modelId → renderer modelIndex (same map ViewportContainer stamps onto
   * flat meshes / point clouds — reused here rather than re-derived, so a
   * shard and its model's flat geometry always agree on ownership). Missing
   * entry (legacy single-model path, no federation) falls back to 0.
   */
  modelIdToIndex?: ReadonlyMap<string, number>;
  /**
   * modelId → express-id offset (`FederatedModel.idOffset`). A federated
   * shard's occurrences carry the RAW ids the worker parsed with — the same
   * offset applied to that model's flat meshes at finalize must be applied
   * here too, or an instanced occurrence's id would never match the one
   * selection/highlighting/props use for the same entity (#1912). A primary
   * model's offset is always 0 (the federation registry is cleared before
   * every primary load), so omitting this param preserves prior behaviour.
   */
  modelIdToOffset?: ReadonlyMap<string, number>;
  /**
   * Model indices whose GPU-instanced templates should survive a reshape
   * (#2073). `scene.clear()` used to run unconditionally on every
   * non-streaming reshape — a federated model add, a model hide, a
   * type-visibility toggle, an in-place content-version bump — which
   * destroyed EVERY model's instanced templates including ones for models
   * still loaded and visible. Nothing re-uploads them afterwards (the raw
   * shard bytes are dropped right after their one-time drain), so repeated
   * geometry (windows, doors, bolts, ...) silently vanished for the rest of
   * the session. Reshapes now call `scene.clearFlatGeometry()` (keeps
   * instanced buffers) and reconcile ownership against this set — any
   * modelIndex the scene still holds templates for but that is NOT in this
   * set gets torn down via `removeInstancedTemplatesForModel`, so a
   * genuinely removed model's instanced geometry does not linger.
   * `undefined` defaults to "only modelIndex 0 is present" — the
   * non-federated case, where `addInstancedShard` has always defaulted new
   * templates to modelIndex 0. Hidden models remain present and masked (#4428).
   */
  presentInstancedModelIndices?: ReadonlySet<number>;
  clearPendingMeshColorUpdates: () => void;
  clearPendingColorUpdates: () => void;
  clearPendingMeshRemovals: () => void;
  /**
   * Prunes drained ids out of the store's `geometryResult.meshes` and
   * subtracts their triangle/vertex counts — see `pruneGeometryMeshes` in
   * `dataSlice.ts`. Called right after `scene.removeMeshesForEntities` so
   * the store stops disagreeing with what the renderer already dropped.
   */
  pruneGeometryMeshes: (ids: Set<number>) => void;
  clearPendingMeshTranslations: () => void;
  clearPendingMeshRotations: () => void;
  clearInstancedShards: () => void;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  releaseGeometryAfterFinalize?: boolean;
  onGeometryReleased?: () => void;
}
