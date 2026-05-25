/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visibility state slice
 *
 * Supports both single-model (legacy) and multi-model visibility.
 * Multi-model visibility uses model-scoped Maps.
 */

import type { StateCreator } from 'zustand';
import type { TypeVisibility, EntityRef } from '../types.js';
import { TYPE_VISIBILITY_DEFAULTS, IFC_ANNOTATIONS_STORAGE_KEY } from '../constants.js';

export interface VisibilitySlice {
  // State (legacy - single model)
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  /** Class-level filter (from Class tab type-group clicks) — independent of isolatedEntities */
  classFilter: { ids: Set<number>; label: string } | null;
  typeVisibility: TypeVisibility;

  // State (multi-model)
  /** Hidden entities per model */
  hiddenEntitiesByModel: Map<string, Set<number>>;
  /** Isolated entities per model (null = show all in that model) */
  isolatedEntitiesByModel: Map<string, Set<number>>;

  // Actions (legacy - maintained for backward compatibility)
  hideEntity: (id: number) => void;
  hideEntities: (ids: number[]) => void;
  showEntity: (id: number) => void;
  showEntities: (ids: number[]) => void;
  toggleEntityVisibility: (id: number) => void;
  isolateEntity: (id: number) => void;
  isolateEntities: (ids: number[]) => void;
  clearIsolation: () => void;
  /** Set class-level filter (IFC class isolation from Class tab) */
  setClassFilter: (ids: number[], label: string) => void;
  clearClassFilter: () => void;
  /** Clear all isolation and class filters */
  clearAllFilters: () => void;
  showAll: () => void;
  isEntityVisible: (id: number) => boolean;
  toggleTypeVisibility: (type: 'spaces' | 'openings' | 'site' | 'ifcAnnotations') => void;
  /** Set all hidden entities at once (for BCF viewpoint application) */
  setHiddenEntities: (ids: Set<number>) => void;
  /** Set all isolated entities at once (for BCF viewpoint with defaultVisibility=false) */
  setIsolatedEntities: (ids: Set<number> | null) => void;

  // Actions (multi-model)
  /** Hide entity in specific model */
  hideEntityInModel: (modelId: string, expressId: number) => void;
  /** Hide multiple entities in specific model */
  hideEntitiesInModel: (modelId: string, expressIds: number[]) => void;
  /** Show entity in specific model */
  showEntityInModel: (modelId: string, expressId: number) => void;
  /** Show multiple entities in specific model */
  showEntitiesInModel: (modelId: string, expressIds: number[]) => void;
  /** Toggle entity visibility in specific model */
  toggleEntityVisibilityInModel: (modelId: string, expressId: number) => void;
  /** Check if entity is visible in specific model */
  isEntityVisibleInModel: (modelId: string, expressId: number) => boolean;
  /** Get hidden entity IDs for a specific model */
  getHiddenEntitiesForModel: (modelId: string) => Set<number>;
  /** Clear visibility state for a model (when model is removed) */
  clearModelVisibility: (modelId: string) => void;
  /** Show all entities across all models */
  showAllInAllModels: () => void;
}

export const createVisibilitySlice: StateCreator<VisibilitySlice, [], [], VisibilitySlice> = (set, get) => ({
  // Initial state (legacy)
  hiddenEntities: new Set(),
  isolatedEntities: null,
  classFilter: null,
  typeVisibility: {
    spaces: TYPE_VISIBILITY_DEFAULTS.SPACES,
    openings: TYPE_VISIBILITY_DEFAULTS.OPENINGS,
    site: TYPE_VISIBILITY_DEFAULTS.SITE,
    ifcAnnotations: TYPE_VISIBILITY_DEFAULTS.IFC_ANNOTATIONS,
  },

  // Initial state (multi-model)
  hiddenEntitiesByModel: new Map(),
  isolatedEntitiesByModel: new Map(),

  // Actions (legacy)
  hideEntity: (id) => set((state) => {
    const newHidden = new Set(state.hiddenEntities);
    newHidden.add(id);
    return { hiddenEntities: newHidden };
  }),

  hideEntities: (ids) => set((state) => {
    const newHidden = new Set(state.hiddenEntities);
    ids.forEach(id => newHidden.add(id));
    return { hiddenEntities: newHidden };
  }),

  showEntity: (id) => set((state) => {
    const newHidden = new Set(state.hiddenEntities);
    newHidden.delete(id);
    return { hiddenEntities: newHidden };
  }),

  showEntities: (ids) => set((state) => {
    const newHidden = new Set(state.hiddenEntities);
    ids.forEach(id => newHidden.delete(id));
    return { hiddenEntities: newHidden };
  }),

  toggleEntityVisibility: (id) => set((state) => {
    const newHidden = new Set(state.hiddenEntities);
    if (newHidden.has(id)) {
      newHidden.delete(id);
    } else {
      newHidden.add(id);
    }
    return { hiddenEntities: newHidden };
  }),

  isolateEntity: (id) => set((state) => {
    // Toggle isolate: if this entity is already the only isolated one, clear isolation
    const isAlreadyIsolated = state.isolatedEntities !== null &&
      state.isolatedEntities.size === 1 &&
      state.isolatedEntities.has(id);

    if (isAlreadyIsolated) {
      return { isolatedEntities: null };
    } else {
      // Isolate this entity (and unhide it)
      const newHidden = new Set(state.hiddenEntities);
      newHidden.delete(id);
      return {
        isolatedEntities: new Set([id]),
        hiddenEntities: newHidden,
      };
    }
  }),

  isolateEntities: (ids) => set((state) => {
    // Toggle isolate: if these exact entities are already isolated, clear isolation
    const idsSet = new Set(ids);
    const isAlreadyIsolated = state.isolatedEntities !== null &&
      state.isolatedEntities.size === idsSet.size &&
      ids.every(id => state.isolatedEntities!.has(id));

    if (isAlreadyIsolated) {
      return { isolatedEntities: null };
    } else {
      // Isolate these entities (and unhide them)
      const newHidden = new Set(state.hiddenEntities);
      ids.forEach(id => newHidden.delete(id));
      return {
        isolatedEntities: idsSet,
        hiddenEntities: newHidden,
      };
    }
  }),

  clearIsolation: () => set({ isolatedEntities: null }),

  setClassFilter: (ids, label) => set((state) => {
    const idsSet = new Set(ids);
    // Toggle: if same class already filtered, clear it
    const isAlready = state.classFilter !== null &&
      state.classFilter.ids.size === idsSet.size &&
      ids.every(id => state.classFilter!.ids.has(id));
    if (isAlready) {
      return { classFilter: null };
    }
    return { classFilter: { ids: idsSet, label } };
  }),

  clearClassFilter: () => set({ classFilter: null }),

  clearAllFilters: () => set({ isolatedEntities: null, classFilter: null }),

  showAll: () => set({ hiddenEntities: new Set(), isolatedEntities: null, classFilter: null }),

  setHiddenEntities: (ids) => set({ hiddenEntities: new Set(ids), isolatedEntities: null, classFilter: null }),

  setIsolatedEntities: (ids) => set({
    isolatedEntities: ids ? new Set(ids) : null,
    hiddenEntities: new Set(), // Clear hidden when setting isolation
  }),

  isEntityVisible: (id) => {
    const state = get();
    if (state.hiddenEntities.has(id)) return false;
    if (state.isolatedEntities !== null && !state.isolatedEntities.has(id)) return false;
    if (state.classFilter !== null && !state.classFilter.ids.has(id)) return false;
    return true;
  },

  toggleTypeVisibility: (type) => set((state) => {
    const next = !state.typeVisibility[type];
    // Persist the annotations/grids toggle so user choice survives
    // reloads. Other type toggles (spaces/openings/site) are session-
    // only and reset to their semantic defaults on next mount; the
    // annotations toggle matters more in practice because users on
    // annotation-heavy files toggle it on/off frequently.
    if (type === 'ifcAnnotations' && typeof window !== 'undefined') {
      try { localStorage.setItem(IFC_ANNOTATIONS_STORAGE_KEY, String(next)); }
      catch { /* private-mode storage rejection — non-fatal */ }
    }
    return {
      typeVisibility: { ...state.typeVisibility, [type]: next },
    };
  }),

  // Actions (multi-model)
  hideEntityInModel: (modelId, expressId) => set((state) => {
    const newMap = new Map(state.hiddenEntitiesByModel);
    const modelHidden = new Set(newMap.get(modelId) || []);
    modelHidden.add(expressId);
    newMap.set(modelId, modelHidden);
    return { hiddenEntitiesByModel: newMap };
  }),

  hideEntitiesInModel: (modelId, expressIds) => set((state) => {
    const newMap = new Map(state.hiddenEntitiesByModel);
    const modelHidden = new Set(newMap.get(modelId) || []);
    expressIds.forEach(id => modelHidden.add(id));
    newMap.set(modelId, modelHidden);
    return { hiddenEntitiesByModel: newMap };
  }),

  showEntityInModel: (modelId, expressId) => set((state) => {
    const newMap = new Map(state.hiddenEntitiesByModel);
    const modelHidden = newMap.get(modelId);
    if (modelHidden) {
      const newSet = new Set(modelHidden);
      newSet.delete(expressId);
      if (newSet.size === 0) {
        newMap.delete(modelId);
      } else {
        newMap.set(modelId, newSet);
      }
    }
    return { hiddenEntitiesByModel: newMap };
  }),

  showEntitiesInModel: (modelId, expressIds) => set((state) => {
    const newMap = new Map(state.hiddenEntitiesByModel);
    const modelHidden = newMap.get(modelId);
    if (modelHidden) {
      const newSet = new Set(modelHidden);
      expressIds.forEach(id => newSet.delete(id));
      if (newSet.size === 0) {
        newMap.delete(modelId);
      } else {
        newMap.set(modelId, newSet);
      }
    }
    return { hiddenEntitiesByModel: newMap };
  }),

  toggleEntityVisibilityInModel: (modelId, expressId) => set((state) => {
    const newMap = new Map(state.hiddenEntitiesByModel);
    const modelHidden = new Set(newMap.get(modelId) || []);

    if (modelHidden.has(expressId)) {
      modelHidden.delete(expressId);
      if (modelHidden.size === 0) {
        newMap.delete(modelId);
      } else {
        newMap.set(modelId, modelHidden);
      }
    } else {
      modelHidden.add(expressId);
      newMap.set(modelId, modelHidden);
    }

    return { hiddenEntitiesByModel: newMap };
  }),

  isEntityVisibleInModel: (modelId, expressId) => {
    const state = get();
    const modelHidden = state.hiddenEntitiesByModel.get(modelId);
    if (modelHidden?.has(expressId)) return false;

    const modelIsolated = state.isolatedEntitiesByModel.get(modelId);
    if (modelIsolated && !modelIsolated.has(expressId)) return false;

    return true;
  },

  getHiddenEntitiesForModel: (modelId) => {
    return get().hiddenEntitiesByModel.get(modelId) || new Set();
  },

  clearModelVisibility: (modelId) => set((state) => {
    const newHiddenMap = new Map(state.hiddenEntitiesByModel);
    const newIsolatedMap = new Map(state.isolatedEntitiesByModel);
    newHiddenMap.delete(modelId);
    newIsolatedMap.delete(modelId);
    return {
      hiddenEntitiesByModel: newHiddenMap,
      isolatedEntitiesByModel: newIsolatedMap,
    };
  }),

  showAllInAllModels: () => set({
    hiddenEntities: new Set(),
    isolatedEntities: null,
    classFilter: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
  }),
});
