/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import { carryReleasedMesh, retainReleasedMeshProvenance } from '@/lib/released-mesh-provenance';
import { pruneMeshesFromGeometry } from './data-mesh-prune.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, CoordinateInfo } from '@ifc-lite/geometry';
import type { FederatedModel } from '../types.js';
import { appendGeometryBatchPatch } from './dataSlice.appendGeometryBatch.js';
import { noteInstancedShardModel } from '../instancedShardModels.js';

/**
 * Cross-slice state that dataSlice reads/writes via the combined store.
 *
 * Data updaters sync `ifcDataStore` / `geometryResult` into the per-model
 * entry inside the ModelSlice `models` map so that federation stays
 * consistent.  The types below describe the minimal ModelSlice surface
 * that dataSlice accesses through the merged Zustand state.
 */
export interface DataCrossSliceState {
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
}

export interface DataSlice {
  // State
  ifcDataStore: IfcDataStore | null;
  geometryResult: GeometryResult | null;
  geometryUpdateTick: number;
  /**
   * Monotonic counter bumped whenever existing mesh vertex/normal data has
   * been mutated in-place (e.g. by `realignFederation`). Length/visibility
   * triggers don't catch in-place mutation, so this is a separate signal that
   * the merged-geometry cache and the renderer's GPU buffers both subscribe
   * to in order to force a re-process.
   */
  geometryContentVersion: number;
  boundedGeometryMode: boolean;
  /** Transient overlay colors (lens/IDS/sdk overlays). */
  pendingColorUpdates: Map<number, [number, number, number, number]> | null;
  /** Monotonic durable revision of renderer color deliveries (clearing the queue does not bump it). */ colorPresentationRevision: number;
  /** Persistent mesh color updates (IFC deferred style/material colors). */
  pendingMeshColorUpdates: Map<number, [number, number, number, number]> | null;
  /**
   * Pre-override colors for every entity an *overriding* `updateMeshColors`
   * call has baked over, keyed by expressId — what `resetMeshColors` restores.
   * First write per entity wins, so successive overrides never clobber the
   * ORIGINAL color with an intermediate one. Null when nothing is overridden.
   *
   * Only `updateMeshColors(updates, { override: true })` records here. The
   * loader's own deferred IFC style/material pass goes through the same action
   * WITHOUT that flag, precisely so a later reset restores the model's IFC
   * colors rather than stripping them back to the pre-style defaults.
   */
  meshColorBackup: Map<number, [number, number, number, number]> | null;

  // Actions
  setIfcDataStore: (result: IfcDataStore | null) => void;
  setGeometryResult: (result: GeometryResult | null) => void;
  setBoundedGeometryMode: (enabled: boolean) => void;
  /**
   * Append newly created meshes to the geometry of the model that OWNS
   * them — `modelId` is required and never inferred (#4922). See
   * `appendGeometryBatchPatch` in `dataSlice.appendGeometryBatch.ts` for the
   * routing contract.
   */
  appendGeometryBatch: (modelId: string, meshes: GeometryResult['meshes'], coordinateInfo?: CoordinateInfo) => void;
  /** Signal that mesh positions/normals have been mutated in place — see
   *  `geometryContentVersion` for why this is separate from setGeometryResult. */
  bumpGeometryContentVersion: () => void;
  releaseGeometryMemory: () => void;
  /**
   * Persist mesh color changes in geometryResult (used for IFC style/material
   * updates).
   *
   * Pass `{ override: true }` when the colors are a *temporary* override on top
   * of whatever the mesh already shows (the embed API's `SET_COLORS`): the
   * displaced colors are captured in `meshColorBackup` so `resetMeshColors`
   * can put them back. The loader's IFC style pass deliberately omits it — the
   * colors it writes ARE the model's colors, and backing them up would make a
   * later reset strip the model's styling.
   */
  updateMeshColors: (
    updates: Map<number, [number, number, number, number]>,
    options?: { override?: boolean },
  ) => void;
  /**
   * Pending mesh removals for the renderer. Authoring actions (split, delete)
   * push globalIds here; `useGeometryStreaming` flushes them on the next frame
   * via `scene.removeMeshesForEntities`, then calls `pruneGeometryMeshes` to
   * drop the matching meshes out of `geometryResult.meshes` so picking and
   * bounds recomputation stay consistent.
   *
   * A Set on the slice rather than a transient ref, so tests and headless
   * workflows can observe it directly.
   */
  pendingMeshRemovals: Set<number> | null;
  setPendingMeshRemovals: (ids: Set<number>) => void;
  clearPendingMeshRemovals: () => void;
  pruneGeometryMeshes: (ids: Set<number>) => void;
  /**
   * Emit-both GPU-instancing: raw IFNS shard bytes (transferable ArrayBuffers)
   * collated per geometry batch by the worker, tagged with the owning model's
   * id. `useGeometryStreaming` drains them each frame via
   * `scene.addInstancedShard` (decode + upload as instanced templates),
   * resolving `modelId` to the renderer's `modelIndex` and to that model's
   * express-id offset so occurrences land under the right owner and match
   * the ids used everywhere else for that model (#1912). Additive overlay on
   * the flat geometry; null when none pending. A primary load's `modelId`
   * always carries idOffset 0 (the federation registry is cleared before
   * every primary load), so the primary path behaves exactly as before this
   * tagging was added.
   */
  pendingInstancedShards: Array<{ modelId: string; bytes: ArrayBuffer }> | null;
  appendInstancedShards: (modelId: string, shards: ArrayBuffer[]) => void;
  clearInstancedShards: () => void;
  /**
   * Pending per-entity translations for the renderer. Authoring
   * actions (translateEntity, setEntityPosition, gizmo drag) push
   * `globalId → [dx, dy, dz]` in *renderer* frame (Y-up). The
   * streaming hook drains via `scene.translateMeshesForEntities`
   * on the next frame, which mutates vertex positions in place
   * and marks the affected buckets for re-batch.
   *
   * The delta is renderer-frame; the IFC → renderer conversion
   * lives in the action that produces the entry.
   */
  pendingMeshTranslations: Map<number, [number, number, number]> | null;
  setPendingMeshTranslations: (updates: Map<number, [number, number, number]>) => void;
  clearPendingMeshTranslations: () => void;
  /**
   * Pending per-entity yaw rotations for the renderer. `globalId → {angle
   * (radians, renderer +Y axis), pivot (renderer world, Y-up)}`. Drained by
   * the streaming hook via `scene.rotateMeshesForEntities`, which rotates
   * vertices + normals in place. Angles accumulate across calls (one combined
   * rotation per entity per frame); the latest pivot wins.
   */
  pendingMeshRotations: Map<number, { angle: number; pivot: [number, number, number] }> | null;
  setPendingMeshRotations: (updates: Map<number, { angle: number; pivot: [number, number, number] }>) => void;
  clearPendingMeshRotations: () => void;
  /** Set pending color updates for the renderer without cloning mesh data.
   *  Use this for transient overlays (lens, IDS) where the source-of-truth
   *  mesh colors should remain unchanged. */
  setPendingColorUpdates: (updates: Map<number, [number, number, number, number]>) => void;
  clearPendingColorUpdates: () => void;
  clearPendingMeshColorUpdates: () => void;
  /**
   * Undo every overriding `updateMeshColors` bake since the backup was last
   * empty: restores `geometryResult.meshes[].color` from `meshColorBackup`,
   * re-queues those restored colors on `pendingMeshColorUpdates` so the
   * renderer re-uploads them, and clears the backup.
   *
   * Deliberately does NOT touch `pendingColorUpdates`. That is a different
   * channel with different owners — the lens, IDS, clash and schedule overlays
   * each install and release their own state there — and clearing it from here
   * would destroy a claim this subsystem never made.
   */
  resetMeshColors: () => void;
  updateCoordinateInfo: (coordinateInfo: CoordinateInfo) => void;
}

/**
 * Patch that writes `geometryResult` to the top-level mirror AND the active
 * model's record, as ONE shared object. Every action that replaces the mirror
 * must go through here: `appendGeometryBatch` builds on the model record
 * (#4922) and `pruneMeshesFromGeometry` prunes each shared object once, so a
 * mirror-only write (e.g. a recolor) would be silently reverted by the next
 * append or active-model switch.
 */
function withActiveModelGeometry(
  state: Pick<DataCrossSliceState, 'activeModelId' | 'models'>,
  geometryResult: GeometryResult | null,
): { geometryResult: GeometryResult | null; models?: Map<string, FederatedModel> } {
  const modelId = state.activeModelId;
  const model = modelId ? state.models.get(modelId) : undefined;
  if (!modelId || !model) return { geometryResult };
  const models = new Map(state.models);
  models.set(modelId, { ...model, geometryResult });
  return { geometryResult, models };
}

const EMPTY_POSITIONS = new Float32Array(0);
const EMPTY_NORMALS = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);

export const createDataSlice: StateCreator<DataSlice & DataCrossSliceState, [], [], DataSlice> = (set, _get) => ({
  // Initial state
  ifcDataStore: null,
  geometryResult: null,
  geometryUpdateTick: 0,
  geometryContentVersion: 0,
  boundedGeometryMode: false,
  pendingColorUpdates: null,
  colorPresentationRevision: 0,
  pendingMeshColorUpdates: null,
  meshColorBackup: null,
  pendingMeshRemovals: null,
  pendingInstancedShards: null,
  pendingMeshTranslations: null,
  pendingMeshRotations: null,

  // Actions
  setIfcDataStore: (ifcDataStore) => set((state) => {
    const modelId = state.activeModelId;
    if (!modelId) {
      return { ifcDataStore };
    }

    const model = state.models.get(modelId);
    if (!model) {
      return { ifcDataStore };
    }

    const models = new Map(state.models);
    models.set(modelId, { ...model, ifcDataStore });
    return { ifcDataStore, models };
  }),

  setGeometryResult: (geometryResult) => set((state) => {
    // Replacing the geometry invalidates the colour backup: it maps global
    // express id -> the element's ORIGINAL colour, and the incoming meshes
    // reuse those ids for different elements. `useIfcFederation` calls this on
    // an ACTIVE-MODEL SWITCH, so without this `resetMeshColors` restores the
    // model you just left onto the one you just opened.
    //
    // Keyed on IDENTITY, not on every call: a redundant set of the same object
    // changes nothing, and dropping the backup there would destroy a live undo
    // for no gain -- the mistake this fix already made once, in `removeModel`.
    const backup = geometryResult !== state.geometryResult ? { meshColorBackup: null } : {};

    return { ...withActiveModelGeometry(state, geometryResult), geometryUpdateTick: state.geometryUpdateTick + 1, ...backup };
  }),

  setBoundedGeometryMode: (boundedGeometryMode) => set({ boundedGeometryMode }),

  bumpGeometryContentVersion: () => set((state) => ({
    geometryContentVersion: state.geometryContentVersion + 1,
  })),

  appendGeometryBatch: (modelId, meshes, coordinateInfo) => set((state) => (
    appendGeometryBatchPatch(state, modelId, meshes, coordinateInfo)
  )),
  releaseGeometryMemory: () => set((state) => {
    if (!state.geometryResult || !state.boundedGeometryMode) {
      return {};
    }

    const meshes = state.geometryResult.meshes;
    for (let i = 0; i < meshes.length; i++) {
      retainReleasedMeshProvenance(meshes[i]);
      meshes[i].positions = EMPTY_POSITIONS;
      meshes[i].normals = EMPTY_NORMALS;
      meshes[i].indices = EMPTY_INDICES;
      delete meshes[i].appearanceSource;
    }

    const geometryResult = {
      ...state.geometryResult,
      meshes,
    };
    return { ...withActiveModelGeometry(state, geometryResult), geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),

  updateMeshColors: (updates, options) => set((state) => {
    // Clone the Map to prevent external mutation
    const clonedUpdates = new Map(updates);

    if (!state.geometryResult) {
      // Federation mode: no local geometryResult (geometry lives in models Map).
      // Still queue renderer updates for scene batch recoloring.
      return { pendingMeshColorUpdates: clonedUpdates };
    }

    // Capture the displaced color for every entity this call overrides that
    // isn't already backed up — first write wins, so repeated overrides don't
    // clobber the ORIGINAL color with an intermediate one. Only for override
    // callers: see `meshColorBackup`.
    const meshColorBackup = options?.override
      ? new Map(state.meshColorBackup ?? [])
      : null;

    // New array reference so useGeometryStreaming's useEffect detects the change.
    // Only runs once at 'complete' (not per-batch), so O(n) .map() is fine.
    const updatedMeshes = state.geometryResult.meshes.map(mesh => {
      const newColor = clonedUpdates.get(mesh.expressId);
      if (newColor) {
        if (meshColorBackup && !meshColorBackup.has(mesh.expressId)) {
          meshColorBackup.set(mesh.expressId, mesh.color);
        }
        return carryReleasedMesh(mesh, { ...mesh, color: newColor });
      }
      return mesh;
    });
    return {
      ...withActiveModelGeometry(state, { ...state.geometryResult, meshes: updatedMeshes }),
      pendingMeshColorUpdates: clonedUpdates,
      ...(meshColorBackup ? { meshColorBackup } : {}),
    };
  }),

  setPendingColorUpdates: (updates) => set((state) => ({ pendingColorUpdates: new Map(updates), colorPresentationRevision: state.colorPresentationRevision + 1 })),

  clearPendingColorUpdates: () => set({ pendingColorUpdates: null }),

  clearPendingMeshColorUpdates: () => set({ pendingMeshColorUpdates: null }),

  resetMeshColors: () => set((state) => {
    const backup = state.meshColorBackup;
    if (!backup || backup.size === 0) {
      // Nothing was overridden — and nothing to clear either. Leaving
      // `pendingMeshColorUpdates` alone matters: the loader's deferred IFC
      // style pass queues there, and a reset arriving mid-load must not drop
      // the model's own colors before the renderer has drained them.
      return {};
    }

    if (!state.geometryResult) {
      // Federation mode: no local geometryResult to restore colors on; still
      // forward the restore to the renderer's pending queue.
      return { pendingMeshColorUpdates: new Map(backup), meshColorBackup: null };
    }

    const restoredMeshes = state.geometryResult.meshes.map(mesh => {
      const original = backup.get(mesh.expressId);
      return original ? { ...mesh, color: original } : mesh;
    });

    return {
      ...withActiveModelGeometry(state, { ...state.geometryResult, meshes: restoredMeshes }),
      pendingMeshColorUpdates: new Map(backup),
      meshColorBackup: null,
    };
  }),

  setPendingMeshRemovals: (ids) => set((state) => {
    // Accumulate across calls — the streaming loop drains in one
    // pass per frame, but split / delete actions may fire several
    // times between frames.
    const merged = new Set<number>(state.pendingMeshRemovals ?? []);
    for (const id of ids) merged.add(id);
    return { pendingMeshRemovals: merged };
  }),

  clearPendingMeshRemovals: () => set({ pendingMeshRemovals: null }),
  pruneGeometryMeshes: (ids) => set((state) => pruneMeshesFromGeometry(state, ids)),

  appendInstancedShards: (modelId, shards) => set((state) => {
    if (shards.length > 0) noteInstancedShardModel(modelId);
    return {
    // Accumulate across batches — useGeometryStreaming drains once per frame.
    pendingInstancedShards: [
      ...(state.pendingInstancedShards ?? []),
      ...shards.map((bytes) => ({ modelId, bytes })),
    ],
    };
  }),

  clearInstancedShards: () => set({ pendingInstancedShards: null }),

  setPendingMeshTranslations: (updates) => set((state) => {
    // Accumulate deltas across calls — a single drag-frame may
    // bump translateEntity many times before the streaming hook
    // drains. Existing entries get their delta summed; the
    // renderer sees one combined translation per entity.
    const merged = new Map<number, [number, number, number]>(state.pendingMeshTranslations ?? []);
    for (const [id, delta] of updates) {
      const existing = merged.get(id);
      if (existing) {
        merged.set(id, [
          existing[0] + delta[0],
          existing[1] + delta[1],
          existing[2] + delta[2],
        ]);
      } else {
        merged.set(id, [delta[0], delta[1], delta[2]]);
      }
    }
    return { pendingMeshTranslations: merged };
  }),

  clearPendingMeshTranslations: () => set({ pendingMeshTranslations: null }),

  setPendingMeshRotations: (updates) => set((state) => {
    // Accumulate angles across calls (a drag may bump rotateEntity many times
    // before the streaming hook drains); the latest pivot wins.
    const merged = new Map<number, { angle: number; pivot: [number, number, number] }>(
      state.pendingMeshRotations ?? [],
    );
    for (const [id, { angle, pivot }] of updates) {
      const existing = merged.get(id);
      merged.set(id, { angle: (existing?.angle ?? 0) + angle, pivot });
    }
    return { pendingMeshRotations: merged };
  }),

  clearPendingMeshRotations: () => set({ pendingMeshRotations: null }),

  updateCoordinateInfo: (coordinateInfo) => set((state) => {
    if (!state.geometryResult) return {};
    const geometryResult = {
      ...state.geometryResult,
      coordinateInfo,
    };
    return { ...withActiveModelGeometry(state, geometryResult), geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),
});
