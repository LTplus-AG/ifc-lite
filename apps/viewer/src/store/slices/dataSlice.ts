/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data state slice (IFC data and geometry)
 */

import type { StateCreator } from 'zustand';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, CoordinateInfo } from '@ifc-lite/geometry';
import type { FederatedModel } from '../types.js';
import { DATA_DEFAULTS } from '../constants.js';

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
  boundedGeometryMode: boolean;
  /** Transient overlay colors (lens/IDS/sdk overlays). */
  pendingColorUpdates: Map<number, [number, number, number, number]> | null;
  /** Persistent mesh color updates (IFC deferred style/material colors). */
  pendingMeshColorUpdates: Map<number, [number, number, number, number]> | null;

  // Actions
  setIfcDataStore: (result: IfcDataStore | null) => void;
  setGeometryResult: (result: GeometryResult | null) => void;
  setBoundedGeometryMode: (enabled: boolean) => void;
  appendGeometryBatch: (meshes: GeometryResult['meshes'], coordinateInfo?: CoordinateInfo) => void;
  releaseGeometryMemory: () => void;
  /** Persist mesh color changes in geometryResult (used for IFC style/material updates). */
  updateMeshColors: (updates: Map<number, [number, number, number, number]>) => void;
  /** Set pending color updates for the renderer without cloning mesh data.
   *  Use this for transient overlays (lens, IDS) where the source-of-truth
   *  mesh colors should remain unchanged. */
  setPendingColorUpdates: (updates: Map<number, [number, number, number, number]>) => void;
  clearPendingColorUpdates: () => void;
  clearPendingMeshColorUpdates: () => void;
  updateCoordinateInfo: (coordinateInfo: CoordinateInfo) => void;
}

const getDefaultCoordinateInfo = (): CoordinateInfo => ({
  // Create fresh copies to avoid shared object references
  originShift: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  originalBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  shiftedBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  hasLargeCoordinates: DATA_DEFAULTS.HAS_LARGE_COORDINATES,
});

const EMPTY_POSITIONS = new Float32Array(0);
const EMPTY_NORMALS = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);

export const createDataSlice: StateCreator<DataSlice & DataCrossSliceState, [], [], DataSlice> = (set, get) => ({
  // Initial state
  ifcDataStore: null,
  geometryResult: null,
  geometryUpdateTick: 0,
  boundedGeometryMode: false,
  pendingColorUpdates: null,
  pendingMeshColorUpdates: null,

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
    const modelId = state.activeModelId;
    if (!modelId) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }

    const model = state.models.get(modelId);
    if (!model) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }

    const models = new Map(state.models);
    models.set(modelId, { ...model, geometryResult });
    return { geometryResult, models, geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),

  setBoundedGeometryMode: (boundedGeometryMode) => set({ boundedGeometryMode }),

  appendGeometryBatch: (meshes, coordinateInfo) => set((state) => {
    // Incremental totals: O(batch_size) instead of O(total_accumulated) .reduce()
    let batchTriangles = 0;
    let batchVertices = 0;
    for (let i = 0; i < meshes.length; i++) {
      batchTriangles += meshes[i].indices.length / 3;
      batchVertices += meshes[i].positions.length / 3;
    }

    if (!state.geometryResult) {
      const geometryResult = {
        meshes: meshes.slice(),
        totalTriangles: batchTriangles,
        totalVertices: batchVertices,
        coordinateInfo: coordinateInfo || getDefaultCoordinateInfo(),
      };
      const modelId = state.activeModelId;
      if (!modelId) {
        return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
      }
      const model = state.models.get(modelId);
      if (!model) {
        return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
      }
      const models = new Map(state.models);
      models.set(modelId, { ...model, geometryResult });
      return { geometryResult, models, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }

    // Mutate the existing array in-place (O(batch) per append) instead of
    // .concat() (O(total) per append) to avoid O(N²) for large files.
    // The new geometryResult object reference below is sufficient for
    // Zustand/React change detection — array identity doesn't need to change.
    const existingMeshes = state.geometryResult.meshes;
    for (let i = 0; i < meshes.length; i++) {
      existingMeshes.push(meshes[i]);
    }

    const geometryResult = {
      ...state.geometryResult,
      meshes: existingMeshes,
      totalTriangles: state.geometryResult.totalTriangles + batchTriangles,
      totalVertices: state.geometryResult.totalVertices + batchVertices,
      coordinateInfo: coordinateInfo || state.geometryResult.coordinateInfo,
    };
    const modelId = state.activeModelId;
    if (!modelId) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const model = state.models.get(modelId);
    if (!model) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const models = new Map(state.models);
    models.set(modelId, { ...model, geometryResult });
    return { geometryResult, models, geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),

  releaseGeometryMemory: () => set((state) => {
    if (!state.geometryResult || !state.boundedGeometryMode) {
      return {};
    }

    const meshes = state.geometryResult.meshes;
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].positions = EMPTY_POSITIONS;
      meshes[i].normals = EMPTY_NORMALS;
      meshes[i].indices = EMPTY_INDICES;
    }

    const geometryResult = {
      ...state.geometryResult,
      meshes,
    };
    const modelId = state.activeModelId;
    if (!modelId) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const model = state.models.get(modelId);
    if (!model) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const models = new Map(state.models);
    models.set(modelId, { ...model, geometryResult });
    return { geometryResult, models, geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),

  updateMeshColors: (updates) => set((state) => {
    // Clone the Map to prevent external mutation
    const clonedUpdates = new Map(updates);

    if (!state.geometryResult) {
      // Federation mode: no local geometryResult (geometry lives in models Map).
      // Still queue renderer updates for scene batch recoloring.
      return { pendingMeshColorUpdates: clonedUpdates };
    }

    // New array reference so useGeometryStreaming's useEffect detects the change.
    // Only runs once at 'complete' (not per-batch), so O(n) .map() is fine.
    const updatedMeshes = state.geometryResult.meshes.map(mesh => {
      const newColor = clonedUpdates.get(mesh.expressId);
      if (newColor) {
        return { ...mesh, color: newColor };
      }
      return mesh;
    });
    return {
      geometryResult: {
        ...state.geometryResult,
        meshes: updatedMeshes,
      },
      pendingMeshColorUpdates: clonedUpdates,
    };
  }),

  setPendingColorUpdates: (updates) => set({ pendingColorUpdates: new Map(updates) }),

  clearPendingColorUpdates: () => set({ pendingColorUpdates: null }),

  clearPendingMeshColorUpdates: () => set({ pendingMeshColorUpdates: null }),

  updateCoordinateInfo: (coordinateInfo) => set((state) => {
    if (!state.geometryResult) return {};
    const geometryResult = {
      ...state.geometryResult,
      coordinateInfo,
    };
    const modelId = state.activeModelId;
    if (!modelId) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const model = state.models.get(modelId);
    if (!model) {
      return { geometryResult, geometryUpdateTick: state.geometryUpdateTick + 1 };
    }
    const models = new Map(state.models);
    models.set(modelId, { ...model, geometryResult });
    return { geometryResult, models, geometryUpdateTick: state.geometryUpdateTick + 1 };
  }),
});
