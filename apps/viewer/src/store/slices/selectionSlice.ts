/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection state slice
 *
 * Supports both single-model (legacy) and multi-model selection.
 * Multi-model selection uses compound EntityRef identifiers.
 */

import type { StateCreator } from 'zustand';
import type { EntityRef } from '../types.js';
import { entityRefToString, stringToEntityRef } from '../types.js';

export interface SelectionSlice {
  // State (legacy - single model)
  selectedEntityId: number | null;
  selectedEntityIds: Set<number>;
  selectedStoreys: Set<number>;

  // State (multi-model)
  /** Primary selected entity with model context */
  selectedEntity: EntityRef | null;
  /** Multi-selection across models: serialized EntityRef strings */
  selectedEntitiesSet: Set<string>;
  /** Array of selected entities for property panel display (e.g., unified storeys) */
  selectedEntities: EntityRef[];
  /** Selected model ID for metadata display (when clicking top-level model in hierarchy) */
  selectedModelId: string | null;

  // Actions (legacy - single model, maintained for backward compatibility)
  setSelectedEntityId: (id: number | null) => void;
  toggleStoreySelection: (id: number) => void;
  setStoreySelection: (id: number) => void;
  setStoreysSelection: (ids: number[]) => void;
  clearStoreySelection: () => void;
  addToSelection: (id: number) => void;
  removeFromSelection: (id: number) => void;
  toggleSelection: (id: number) => void;
  setSelectedEntityIds: (ids: number[]) => void;
  clearSelection: () => void;

  // Actions (multi-model)
  /** Set primary selection with model context */
  setSelectedEntity: (ref: EntityRef | null) => void;
  /** Add entity to multi-selection */
  addEntityToSelection: (ref: EntityRef) => void;
  /**
   * Batch-add multiple entities to multi-selection in a single Zustand
   * `set`. Use for bulk paths like "Select all visible results" — the
   * naïve loop over `addEntityToSelection` re-renders every subscriber
   * O(N) times for an N-row select. Empty input is a no-op.
   */
  addEntitiesToSelection: (refs: ReadonlyArray<EntityRef>) => void;
  /** Remove entity from multi-selection */
  removeEntityFromSelection: (ref: EntityRef) => void;
  /** Toggle entity in multi-selection */
  toggleEntitySelection: (ref: EntityRef) => void;
  /** Clear all entity selection (both single and multi) */
  clearEntitySelection: () => void;
  /** Check if entity is selected */
  isEntitySelected: (ref: EntityRef) => boolean;
  /** Get all selected entities for a specific model */
  getSelectedEntitiesForModel: (modelId: string) => number[];
  /** Set multiple entities for property panel display (e.g., unified storeys) */
  setSelectedEntities: (refs: EntityRef[]) => void;
  /** Set selected model for metadata display */
  setSelectedModelId: (modelId: string | null) => void;
}

export const createSelectionSlice: StateCreator<SelectionSlice, [], [], SelectionSlice> = (set, get) => ({
  // Initial state (legacy)
  selectedEntityId: null,
  selectedEntityIds: new Set(),
  selectedStoreys: new Set(),

  // Initial state (multi-model)
  selectedEntity: null,
  selectedEntitiesSet: new Set(),
  selectedEntities: [],
  selectedModelId: null,

  // Actions (legacy - maintained for backward compatibility)
  setSelectedEntityId: (selectedEntityId) => set((state) => ({
    selectedEntityId,
    // Clear model selection when an entity is selected (but not when clearing selection)
    selectedModelId: selectedEntityId !== null ? null : state.selectedModelId,
  })),

  toggleStoreySelection: (id) => set((state) => {
    const newSelection = new Set(state.selectedStoreys);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    return { selectedStoreys: newSelection };
  }),

  setStoreySelection: (id) => set((state) => {
    // If already the only selected storey, deselect it (toggle behavior)
    if (state.selectedStoreys.size === 1 && state.selectedStoreys.has(id)) {
      return { selectedStoreys: new Set() };
    }
    // Otherwise, select only this storey
    return { selectedStoreys: new Set([id]) };
  }),

  setStoreysSelection: (ids) => set({ selectedStoreys: new Set(ids) }),

  clearStoreySelection: () => set({ selectedStoreys: new Set() }),

  addToSelection: (id) => set((state) => {
    const newSelection = new Set(state.selectedEntityIds);
    newSelection.add(id);
    return { selectedEntityIds: newSelection, selectedEntityId: id };
  }),

  removeFromSelection: (id) => set((state) => {
    const newSelection = new Set(state.selectedEntityIds);
    newSelection.delete(id);
    const remaining = Array.from(newSelection);
    return {
      selectedEntityIds: newSelection,
      selectedEntityId: remaining.length > 0 ? remaining[remaining.length - 1] : null,
    };
  }),

  toggleSelection: (id) => set((state) => {
    const newSelection = new Set(state.selectedEntityIds);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    const remaining = Array.from(newSelection);
    return {
      selectedEntityIds: newSelection,
      selectedEntityId: remaining.length > 0 ? remaining[remaining.length - 1] : null,
    };
  }),

  setSelectedEntityIds: (ids) => set({
    selectedEntityIds: new Set(ids),
    selectedEntityId: ids.length > 0 ? ids[ids.length - 1] : null,
  }),

  clearSelection: () => set({
    selectedEntityIds: new Set(),
    selectedEntityId: null,
  }),

  // Actions (multi-model)
  // NOTE: This ONLY sets selectedEntity, NOT selectedEntityId.
  // In multi-model mode, selectedEntityId is the GLOBAL ID (for renderer highlighting)
  // and selectedEntity.expressId is the ORIGINAL express ID (for property lookup).
  // The caller should use setSelectedEntityId(globalId) separately for highlighting.
  setSelectedEntity: (ref) => set({
    selectedEntity: ref,
    selectedEntities: [], // Clear multi-entity selection when setting single entity
    // NOTE: Don't clear selectedModelId here - it's cleared by setSelectedEntityId
    // when an entity is actually selected. This prevents race conditions with
    // useModelSelection which calls setSelectedEntity when selectedEntityId changes.
    // DO NOT update selectedEntityId here - it would overwrite the globalId with expressId!
    // The renderer needs the globalId in selectedEntityId for highlighting.
  }),

  addEntityToSelection: (ref) => set((state) => {
    const key = entityRefToString(ref);
    const newSet = new Set(state.selectedEntitiesSet);
    newSet.add(key);
    return {
      selectedEntitiesSet: newSet,
      selectedEntity: ref,
      // NOTE: Don't update selectedEntityId here - caller should use setSelectedEntityId(globalId)
    };
  }),

  addEntitiesToSelection: (refs) => set((state) => {
    if (refs.length === 0) return {};
    const newSet = new Set(state.selectedEntitiesSet);
    for (const ref of refs) newSet.add(entityRefToString(ref));
    // Primary selection becomes the LAST ref in the input — matches the
    // existing addEntityToSelection convention where the most recent
    // add is treated as primary.
    return {
      selectedEntitiesSet: newSet,
      selectedEntity: refs[refs.length - 1],
    };
  }),

  removeEntityFromSelection: (ref) => set((state) => {
    const key = entityRefToString(ref);
    const newSet = new Set(state.selectedEntitiesSet);
    newSet.delete(key);

    // Update primary selection if needed
    let newPrimary: EntityRef | null = state.selectedEntity;
    if (state.selectedEntity?.modelId === ref.modelId && state.selectedEntity?.expressId === ref.expressId) {
      // Primary was removed, pick another if available
      const remaining = Array.from(newSet);
      newPrimary = remaining.length > 0 ? stringToEntityRef(remaining[remaining.length - 1]) : null;
    }

    return {
      selectedEntitiesSet: newSet,
      selectedEntity: newPrimary,
      // NOTE: Don't update selectedEntityId here - caller should manage it separately
      // Clear it only if nothing is selected
      selectedEntityId: newPrimary ? state.selectedEntityId : null,
    };
  }),

  toggleEntitySelection: (ref) => set((state) => {
    const key = entityRefToString(ref);
    const newSet = new Set(state.selectedEntitiesSet);

    if (newSet.has(key)) {
      newSet.delete(key);
      // Update primary if this was it
      let newPrimary: EntityRef | null = state.selectedEntity;
      if (state.selectedEntity?.modelId === ref.modelId && state.selectedEntity?.expressId === ref.expressId) {
        const remaining = Array.from(newSet);
        newPrimary = remaining.length > 0 ? stringToEntityRef(remaining[remaining.length - 1]) : null;
      }
      return {
        selectedEntitiesSet: newSet,
        selectedEntity: newPrimary,
        // NOTE: Don't update selectedEntityId here - caller should manage it separately
        selectedEntityId: newPrimary ? state.selectedEntityId : null,
      };
    } else {
      newSet.add(key);
      return {
        selectedEntitiesSet: newSet,
        selectedEntity: ref,
        // NOTE: Don't update selectedEntityId here - caller should use setSelectedEntityId(globalId)
      };
    }
  }),

  clearEntitySelection: () => set({
    selectedEntity: null,
    selectedEntitiesSet: new Set(),
    selectedEntities: [],
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    selectedModelId: null,
  }),

  isEntitySelected: (ref) => {
    const key = entityRefToString(ref);
    return get().selectedEntitiesSet.has(key);
  },

  getSelectedEntitiesForModel: (modelId) => {
    const state = get();
    const result: number[] = [];
    for (const key of state.selectedEntitiesSet) {
      const ref = stringToEntityRef(key);
      if (ref.modelId === modelId) {
        result.push(ref.expressId);
      }
    }
    return result;
  },

  setSelectedEntities: (refs) => set({
    selectedEntities: refs,
    // Also set the primary selected entity to the first one
    selectedEntity: refs.length > 0 ? refs[0] : null,
    selectedModelId: null, // Clear model selection when selecting entities
  }),

  setSelectedModelId: (modelId) => set({
    selectedModelId: modelId,
    // Clear other selection when selecting a model
    selectedEntity: null,
    selectedEntities: [],
    selectedEntityId: null,
  }),
});
