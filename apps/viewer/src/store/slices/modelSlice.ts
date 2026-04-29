/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model state slice for multi-model federation
 *
 * Uses FederationRegistry for bulletproof ID handling:
 * - Each model gets a unique ID offset at load time
 * - All meshes use globalIds (originalExpressId + offset)
 * - No ID collisions possible between models
 */

import type { StateCreator } from 'zustand';
import type { FederatedModel } from '../types.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { federationRegistry, type GlobalIdLookup } from '@ifc-lite/renderer';

/**
 * Cross-slice fields the model actions write to. `ifcDataStore` and
 * `geometryResult` are owned by `dataSlice` but `modelSlice`'s set()
 * calls need to keep them in sync with the active model.
 */
export interface ModelCrossSliceState {
  ifcDataStore: IfcDataStore | null;
  geometryResult: GeometryResult | null;
}

export interface ModelSlice {
  // State
  /** Map of all loaded models by ID */
  models: Map<string, FederatedModel>;
  /** ID of the currently active model (for property panel focus) */
  activeModelId: string | null;

  // Actions
  /** Add a new model to the federation */
  addModel: (model: FederatedModel) => void;
  /** Add or merge a model in place */
  upsertModel: (model: FederatedModel) => void;
  /** Update an existing model with partial fields */
  updateModel: (modelId: string, patch: Partial<FederatedModel>) => void;
  /** Remove a model from the federation */
  removeModel: (modelId: string) => void;
  /** Clear all models */
  clearAllModels: () => void;
  /** Set the active model for property panel focus */
  setActiveModel: (modelId: string | null) => void;
  /** Toggle model visibility */
  setModelVisibility: (modelId: string, visible: boolean) => void;
  /** Toggle model collapsed state in hierarchy */
  setModelCollapsed: (modelId: string, collapsed: boolean) => void;
  /** Rename a model */
  setModelName: (modelId: string, name: string) => void;
  /** Get a model by ID */
  getModel: (modelId: string) => FederatedModel | undefined;
  /** Get the currently active model */
  getActiveModel: () => FederatedModel | undefined;
  /** Get all visible models */
  getAllVisibleModels: () => FederatedModel[];
  /** Check if any models are loaded */
  hasModels: () => boolean;

  // Federation Registry helpers (wraps the singleton for convenience)
  /**
   * Register a model with the federation registry and get its offset
   * Call this BEFORE adding meshes, passing the max expressId in the model
   */
  registerModelOffset: (modelId: string, maxExpressId: number) => number;
  /** Convert local expressId to globalId */
  toGlobalId: (modelId: string, expressId: number) => number;
  /** Convert globalId back to (modelId, expressId) */
  fromGlobalId: (globalId: number) => GlobalIdLookup | null;
  /** Find which model contains a globalId */
  findModelForGlobalId: (globalId: number) => string | null;
  /** Get the offset for a model */
  getModelOffset: (modelId: string) => number | null;

  /**
   * BULLETPROOF: Resolve globalId using model store data instead of singleton registry
   * This is more reliable because it uses Zustand state which is always in sync with React
   */
  resolveGlobalIdFromModels: (globalId: number) => GlobalIdLookup | null;
}

export const createModelSlice: StateCreator<ModelSlice & ModelCrossSliceState, [], [], ModelSlice> = (set, get) => ({
  // Initial state
  models: new Map(),
  activeModelId: null,

  // Actions
  addModel: (model) => set((state) => {
    const newModels = new Map(state.models);
    newModels.set(model.id, model);

    // If first model, make it active
    // If adding more models, collapse all existing by default
    if (state.models.size === 0) {
      return {
        models: newModels,
        activeModelId: model.id,
        ifcDataStore: model.ifcDataStore ?? null,
        geometryResult: model.geometryResult ?? null,
      };
    } else {
      // Collapse existing models when adding new ones
      for (const [id, m] of newModels) {
        if (id !== model.id) {
          newModels.set(id, { ...m, collapsed: true });
        }
      }
      return { models: newModels };
    }
  }),

  upsertModel: (model) => set((state) => {
    const newModels = new Map(state.models);
    const existing = newModels.get(model.id);
    newModels.set(model.id, existing ? { ...existing, ...model } : model);
    const activeModelId = state.activeModelId ?? model.id;
    const activeModel = newModels.get(activeModelId) ?? null;

    return {
      models: newModels,
      activeModelId,
      ifcDataStore: activeModel?.ifcDataStore ?? null,
      geometryResult: activeModel?.geometryResult ?? null,
    };
  }),

  updateModel: (modelId, patch) => set((state) => {
    const model = state.models.get(modelId);
    if (!model) return {};

    const updatedModel = { ...model, ...patch };
    const newModels = new Map(state.models);
    newModels.set(modelId, updatedModel);

    return {
      models: newModels,
      ifcDataStore: state.activeModelId === modelId ? updatedModel.ifcDataStore : state.ifcDataStore,
      geometryResult: state.activeModelId === modelId ? updatedModel.geometryResult : state.geometryResult,
    };
  }),

  removeModel: (modelId) => set((state) => {
    const newModels = new Map(state.models);
    newModels.delete(modelId);

    // Unregister from federation registry
    federationRegistry.unregisterModel(modelId);

    // Update activeModelId if removed model was active
    let newActiveId = state.activeModelId;
    if (state.activeModelId === modelId) {
      const remaining = Array.from(newModels.keys());
      newActiveId = remaining.length > 0 ? remaining[0] : null;
    }

    const activeModel = newActiveId ? newModels.get(newActiveId) : null;

    return {
      models: newModels,
      activeModelId: newActiveId,
      ifcDataStore: activeModel?.ifcDataStore ?? null,
      geometryResult: activeModel?.geometryResult ?? null,
    };
  }),

  clearAllModels: () => {
    // Clear the federation registry
    federationRegistry.clear();
    return set({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: null,
      geometryResult: null,
    });
  },

  setActiveModel: (modelId) => set((state) => {
    const activeModel = modelId ? state.models.get(modelId) : null;
    return {
      activeModelId: modelId,
      ifcDataStore: activeModel?.ifcDataStore ?? null,
      geometryResult: activeModel?.geometryResult ?? null,
    };
  }),

  setModelVisibility: (modelId, visible) => set((state) => {
    const model = state.models.get(modelId);
    if (!model) return {};

    const newModels = new Map(state.models);
    newModels.set(modelId, { ...model, visible });
    return { models: newModels };
  }),

  setModelCollapsed: (modelId, collapsed) => set((state) => {
    const model = state.models.get(modelId);
    if (!model) return {};

    const newModels = new Map(state.models);
    newModels.set(modelId, { ...model, collapsed });
    return { models: newModels };
  }),

  setModelName: (modelId, name) => set((state) => {
    const model = state.models.get(modelId);
    if (!model) return {};

    const newModels = new Map(state.models);
    newModels.set(modelId, { ...model, name });
    return { models: newModels };
  }),

  // Getters (synchronous access via get())
  getModel: (modelId) => get().models.get(modelId),

  getActiveModel: () => {
    const state = get();
    return state.activeModelId ? state.models.get(state.activeModelId) : undefined;
  },

  getAllVisibleModels: () => {
    return Array.from(get().models.values()).filter(m => m.visible);
  },

  hasModels: () => get().models.size > 0,

  // Federation Registry helpers
  registerModelOffset: (modelId: string, maxExpressId: number) => {
    return federationRegistry.registerModel(modelId, maxExpressId);
  },

  toGlobalId: (modelId: string, expressId: number) => {
    return federationRegistry.toGlobalId(modelId, expressId);
  },

  fromGlobalId: (globalId: number) => {
    return federationRegistry.fromGlobalId(globalId);
  },

  findModelForGlobalId: (globalId: number) => {
    return federationRegistry.getModelForGlobalId(globalId);
  },

  getModelOffset: (modelId: string) => {
    return federationRegistry.getOffset(modelId);
  },

  /**
   * BULLETPROOF: Resolve globalId using model store data instead of singleton registry
   * This iterates through all models and checks if the globalId falls within their range.
   * More reliable than the singleton because it uses Zustand state which is always in sync.
   */
  resolveGlobalIdFromModels: (globalId: number) => {
    const models = get().models;
    const mutationViews = (get() as unknown as { mutationViews?: Map<string, { getNewEntity: (id: number) => unknown }> }).mutationViews;

    // Sort models by offset for correct range checking
    const sortedModels = Array.from(models.values()).sort((a, b) => a.idOffset - b.idOffset);

    // Find the model that contains this globalId.
    //
    // First pass — parse-time range. A model owns ids in
    // `[offset, offset + maxExpressId]` from the original parse. This
    // is the fast path covering 99% of selections.
    //
    // Second pass — overlay-allocated ids. Duplicates / scripted adds
    // through StoreEditor land ABOVE the model's parse-time
    // maxExpressId, so they fall outside the first-pass range. The
    // federation resolver knows nothing about overlay state, so we
    // consult each model's mutation view for the freshly-added
    // entity. Falls back gracefully when no view is registered.
    for (const model of sortedModels) {
      const localId = globalId - model.idOffset;
      if (localId >= 0 && localId <= model.maxExpressId) {
        return { modelId: model.id, expressId: localId };
      }
    }

    if (mutationViews) {
      for (const model of sortedModels) {
        const localId = globalId - model.idOffset;
        if (localId <= model.maxExpressId) continue; // already covered above
        const view = mutationViews.get(model.id);
        if (!view) continue;
        if (view.getNewEntity(localId) !== null) {
          return { modelId: model.id, expressId: localId };
        }
      }
    }

    return null;
  },
});
