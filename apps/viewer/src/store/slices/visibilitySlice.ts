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
import {
  getPersistedTypeVisibility,
  TYPE_VISIBILITY_STORAGE_KEYS,
  TYPE_VISIBILITY_SEMANTIC_DEFAULTS,
  getPersistedTypeViewMode,
  TYPE_VIEW_MODE_STORAGE_KEY,
  type TypeViewMode,
} from '../constants.js';
import {
  staleOwnershipReset,
  type OwnedVisibilityRecords,
} from '../../lib/visibility/ownership.js';

/** The two shared channels, as a write about to be committed sets them. */
interface SharedChannels {
  isolatedEntities: Set<number> | null;
  ghostExceptEntities: Set<number> | null;
}

/**
 * A channel write, plus the invalidation of every visibility-ownership record
 * it just made stale (review of #2867 — see `staleOwnershipReset`).
 *
 * `isolatedEntities` / `ghostExceptEntities` are shared by clash, IDS,
 * "Isolate in 3D", assembly isolation, `LayerDiffView`, Space Sketch, BCF and
 * `syncSourceModel`. Features record what they installed so they can release
 * only that, and a record left behind after ANOTHER owner replaced the channel
 * starts matching again the moment a third owner installs equal content — at
 * which point the stale owner's next release destroys that owner's
 * presentation. Answering it here, where the channels are actually written,
 * covers every owner in both directions at once; answering it per caller
 * covers whichever direction was reported and waits for the next one.
 *
 * `state` is the slice as Zustand hands it in — the COMBINED store at runtime,
 * a single-slice stub in slice-level test harnesses. The record fields are
 * genuinely absent in the latter, which `staleOwnershipReset` tolerates by
 * returning no keys for them.
 */
function writeChannels(state: unknown, next: SharedChannels): SharedChannels & Partial<OwnedVisibilityRecords> {
  return { ...next, ...staleOwnershipReset(state as OwnedVisibilityRecords, next) };
}

export interface VisibilitySlice {
  // State (legacy - single model)
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  /** X-Ray context: when non-null, every entity NOT in this set renders ghosted
   *  (translucent) so a focused subset (e.g. a clash pair) stands out while the
   *  rest stays visible for context. `null` = no ghosting. Drives the renderer's
   *  `ghostExceptIds`. */
  ghostExceptEntities: Set<number> | null;
  /** Class-level filter (from Class tab type-group clicks) — independent of isolatedEntities */
  classFilter: { ids: Set<number>; label: string } | null;
  typeVisibility: TypeVisibility;
  /** 3D view mode for the Model/Types switch (#957 follow-up). 'model' shows
   *  placed occurrences (default); 'types' shows the type-library shapes. */
  typeViewMode: TypeViewMode;
  /** True when the rendered geometry contains any type-library geometry
   *  (geometryClass 1 = orphan type, 2 = instanced type) — i.e. the Model/Types
   *  switch has something to reveal in "Types" mode. Derived from the merged
   *  mesh set by ViewportContainer; most models carry only occurrence geometry
   *  (class 0), so the switch stays hidden for them. */
  hasTypeGeometry: boolean;

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
  toggleTypeVisibility: (type: 'spaces' | 'spatialZones' | 'openings' | 'virtualElements' | 'site' | 'ifcAnnotations' | 'ifcGrid') => void;
  /** Restore every type-visibility toggle to its semantic default (and persist). */
  resetTypeVisibility: () => void;
  /** Set the Model/Types 3D view mode (and persist). */
  setTypeViewMode: (mode: TypeViewMode) => void;
  /** Set whether the current geometry contains type-library geometry — drives
   *  whether the Model/Types switch renders at all. Runtime-only (not persisted);
   *  re-derived from geometry on every load. */
  setHasTypeGeometry: (value: boolean) => void;
  /** Set all hidden entities at once (for BCF viewpoint application) */
  setHiddenEntities: (ids: Set<number>) => void;
  /** Set all isolated entities at once (for BCF viewpoint with defaultVisibility=false) */
  setIsolatedEntities: (ids: Set<number> | null) => void;
  /** Ghost everything except these entities (X-Ray context). `null` clears it. */
  setGhostExceptEntities: (ids: Set<number> | null) => void;
  /**
   * Put a previously CAPTURED view back, all three fields at once.
   *
   * Restoring through the individual setters cannot express this: each of them
   * clears the others (isolation and ghosting are mutually exclusive, and
   * isolation supersedes per-entity hiding), so a three-call replay passes
   * through intermediate states the user never had. That used to be invisible;
   * it stopped being invisible once a channel write started invalidating the
   * ownership records it makes stale (review of #2867) — restoring a captured
   * clash GHOST went `setIsolatedEntities(null)` (which nulls the ghost
   * channel, killing the record) and only then `setGhostExceptEntities(...)`,
   * so the presentation came back with its claim laundered off. That is #2662
   * P2 by another route, and `useClash.run-preserves-isolation.test.tsx` catches
   * it.
   *
   * One `set()`, one final state, one invalidation pass against it: a record
   * that still content-matches what the restore put back survives, exactly as
   * it did before the restore.
   */
  restoreVisibilityState: (prior: {
    isolated: Set<number> | null;
    ghostExcept: Set<number> | null;
    hidden: Set<number>;
  }) => void;
  /** Clear X-Ray context ghosting. */
  clearGhost: () => void;

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
  ghostExceptEntities: null,
  classFilter: null,
  // Read persisted toggles fresh so the user's choices survive reloads.
  typeVisibility: getPersistedTypeVisibility(),
  typeViewMode: getPersistedTypeViewMode(),
  // Derived from geometry at load time — no model is open yet, so default false.
  hasTypeGeometry: false,

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
      return writeChannels(state, { isolatedEntities: null, ghostExceptEntities: state.ghostExceptEntities });
    } else {
      // Isolate this entity (and unhide it)
      const newHidden = new Set(state.hiddenEntities);
      newHidden.delete(id);
      return {
        ...writeChannels(state, { isolatedEntities: new Set([id]), ghostExceptEntities: state.ghostExceptEntities }),
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
      return writeChannels(state, { isolatedEntities: null, ghostExceptEntities: state.ghostExceptEntities });
    } else {
      // Isolate these entities (and unhide them)
      const newHidden = new Set(state.hiddenEntities);
      ids.forEach(id => newHidden.delete(id));
      return {
        ...writeChannels(state, { isolatedEntities: idsSet, ghostExceptEntities: state.ghostExceptEntities }),
        hiddenEntities: newHidden,
      };
    }
  }),

  clearIsolation: () => set((state) => writeChannels(state, {
    isolatedEntities: null,
    ghostExceptEntities: state.ghostExceptEntities,
  })),

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

  clearAllFilters: () => set((state) => ({
    ...writeChannels(state, { isolatedEntities: null, ghostExceptEntities: null }),
    classFilter: null,
  })),

  showAll: () => set((state) => ({
    ...writeChannels(state, { isolatedEntities: null, ghostExceptEntities: null }),
    hiddenEntities: new Set<number>(),
    classFilter: null,
  })),

  setHiddenEntities: (ids) => set((state) => ({
    ...writeChannels(state, { isolatedEntities: null, ghostExceptEntities: null }),
    hiddenEntities: new Set(ids),
    classFilter: null,
  })),

  setIsolatedEntities: (ids) => set((state) => ({
    ...writeChannels(state, {
      isolatedEntities: ids ? new Set(ids) : null,
      ghostExceptEntities: null, // Isolation (hide) and ghosting are mutually exclusive
    }),
    hiddenEntities: new Set<number>(), // Clear hidden when setting isolation
  })),

  setGhostExceptEntities: (ids) => set((state) => writeChannels(state, {
    ghostExceptEntities: ids ? new Set(ids) : null,
    // Ghosting shows the rest translucent — clear isolation (which hides it).
    isolatedEntities: null,
  })),

  restoreVisibilityState: ({ isolated, ghostExcept, hidden }) => set((state) => ({
    // Verbatim, both channels together — the capture can only ever have
    // observed a legal pair, because every writer of these two enforces their
    // mutual exclusion.
    ...writeChannels(state, {
      isolatedEntities: isolated ? new Set(isolated) : null,
      ghostExceptEntities: ghostExcept ? new Set(ghostExcept) : null,
    }),
    hiddenEntities: new Set(hidden),
  })),

  clearGhost: () => set((state) => writeChannels(state, {
    ghostExceptEntities: null,
    isolatedEntities: state.isolatedEntities,
  })),

  isEntityVisible: (id) => {
    const state = get();
    if (state.hiddenEntities.has(id)) return false;
    if (state.isolatedEntities !== null && !state.isolatedEntities.has(id)) return false;
    if (state.classFilter !== null && !state.classFilter.ids.has(id)) return false;
    return true;
  },

  toggleTypeVisibility: (type) => set((state) => {
    const next = !state.typeVisibility[type];
    // Persist every type-visibility toggle so user choice survives
    // reloads. Keyed by type so clearing one preference (e.g. for
    // testing or to reset to defaults) doesn't nuke the others.
    if (typeof window !== 'undefined') {
      const storageKey = TYPE_VISIBILITY_STORAGE_KEYS[type];
      try { localStorage.setItem(storageKey, String(next)); }
      catch { /* private-mode storage rejection — non-fatal */ }
    }
    return {
      typeVisibility: { ...state.typeVisibility, [type]: next },
    };
  }),

  resetTypeVisibility: () => set(() => {
    // Restore semantic defaults and persist them per-key (same storage
    // pattern as toggleTypeVisibility) so the reset survives reloads.
    if (typeof window !== 'undefined') {
      (Object.keys(TYPE_VISIBILITY_STORAGE_KEYS) as (keyof typeof TYPE_VISIBILITY_STORAGE_KEYS)[])
        .forEach((key) => {
          try { localStorage.setItem(TYPE_VISIBILITY_STORAGE_KEYS[key], String(TYPE_VISIBILITY_SEMANTIC_DEFAULTS[key])); }
          catch { /* private-mode storage rejection — non-fatal */ }
        });
    }
    return { typeVisibility: { ...TYPE_VISIBILITY_SEMANTIC_DEFAULTS } };
  }),

  setTypeViewMode: (mode) => set(() => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem(TYPE_VIEW_MODE_STORAGE_KEY, mode); }
      catch { /* private-mode storage rejection — non-fatal */ }
    }
    return { typeViewMode: mode };
  }),

  setHasTypeGeometry: (value) => set((state) => (
    // Return the SAME state reference when unchanged — a fresh `{}` would still
    // merge into a new state object and notify every subscriber (incl. the
    // whole-state useSyncExternalStore in ViewportContainer). Same ref → Zustand
    // skips the notification entirely.
    state.hasTypeGeometry === value ? state : { hasTypeGeometry: value }
  )),

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
    // "Show all" must also drop any X-ray context (clash focus, Space Sketch
    // preview) — the single-model showAll already does.
    ghostExceptEntities: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
  }),
});
