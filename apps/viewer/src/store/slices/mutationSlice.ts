/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutation slice - manages property/quantity mutations for IFC export
 */

import { type StateCreator } from 'zustand';
import type { ViewerState } from '../index.js';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { Mutation, ChangeSet, PropertyValue } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

/** Tracks georeferencing field mutations per model */
export interface GeorefMutationData {
  projectedCRS?: Partial<ProjectedCRS>;
  mapConversion?: Partial<MapConversion>;
}

export interface MutationSlice {
  // State
  /** Mutation views per model */
  mutationViews: Map<string, MutablePropertyView>;
  /** All change sets */
  changeSets: Map<string, ChangeSet>;
  /** Active change set ID */
  activeChangeSetId: string | null;
  /** Undo stack per model */
  undoStacks: Map<string, Mutation[]>;
  /** Redo stack per model */
  redoStacks: Map<string, Mutation[]>;
  /** Models with unsaved changes */
  dirtyModels: Set<string>;
  /** Version counter to trigger re-renders when mutations change */
  mutationVersion: number;
  /** Georeferencing mutations per model */
  georefMutations: Map<string, GeorefMutationData>;

  // Actions - Georeferencing Mutations
  /** Set a georeferencing field value */
  setGeorefField: (
    modelId: string,
    entity: 'projectedCRS' | 'mapConversion',
    field: string,
    value: string | number,
    oldValue?: string | number
  ) => void;
  /** Set multiple georeferencing field values atomically */
  setGeorefFields: (
    modelId: string,
    entity: 'projectedCRS' | 'mapConversion',
    fields: Array<{ field: string; value: string | number; oldValue?: string | number }>
  ) => void;
  /** Get merged georef mutations for a model */
  getGeorefMutations: (modelId: string) => GeorefMutationData | undefined;

  // Actions - Mutation View Management
  /** Get or create mutation view for a model */
  getMutationView: (modelId: string) => MutablePropertyView | null;
  /** Register a mutation view for a model */
  registerMutationView: (modelId: string, view: MutablePropertyView) => void;
  /** Clear mutation view for a model */
  clearMutationView: (modelId: string) => void;

  // Actions - Property Mutations
  /** Set a property value */
  setProperty: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string,
    value: PropertyValue,
    valueType?: PropertyValueType
  ) => Mutation | null;
  /** Delete a property */
  deleteProperty: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string
  ) => Mutation | null;
  /** Create a new property set */
  createPropertySet: (
    modelId: string,
    entityId: number,
    psetName: string,
    properties: Array<{ name: string; value: PropertyValue; type?: PropertyValueType }>
  ) => Mutation | null;
  /** Delete a property set */
  deletePropertySet: (
    modelId: string,
    entityId: number,
    psetName: string
  ) => Mutation | null;

  // Actions - Quantity Mutations
  /** Set a quantity value */
  setQuantity: (
    modelId: string,
    entityId: number,
    qsetName: string,
    quantName: string,
    value: number,
    quantityType?: QuantityType,
    unit?: string
  ) => Mutation | null;
  /** Create a new quantity set */
  createQuantitySet: (
    modelId: string,
    entityId: number,
    qsetName: string,
    quantities: Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>
  ) => Mutation | null;

  // Actions - Attribute Mutations
  /** Set an entity attribute value */
  setAttribute: (
    modelId: string,
    entityId: number,
    attrName: string,
    value: string,
    oldValue?: string
  ) => Mutation | null;

  // Actions - Undo/Redo
  /** Undo last mutation for a model */
  undo: (modelId: string) => void;
  /** Redo last undone mutation for a model */
  redo: (modelId: string) => void;
  /** Check if undo is available */
  canUndo: (modelId: string) => boolean;
  /** Check if redo is available */
  canRedo: (modelId: string) => boolean;

  // Actions - Change Sets
  /** Create a new change set */
  createChangeSet: (name: string) => string;
  /** Get active change set */
  getActiveChangeSet: () => ChangeSet | null;
  /** Set active change set */
  setActiveChangeSet: (id: string | null) => void;
  /** Export change set as JSON */
  exportChangeSet: (id: string) => string | null;
  /** Import change set from JSON */
  importChangeSet: (json: string) => void;

  // Actions - Query
  /** Check if a model has unsaved changes */
  hasChanges: (modelId: string) => boolean;
  /** Get all mutations for a model */
  getMutationsForModel: (modelId: string) => Mutation[];
  /** Get count of modified entities across all models */
  getModifiedEntityCount: () => number;

  // Actions - Reset
  /** Clear all mutations for a model */
  clearMutations: (modelId: string) => void;
  /** Clear all mutations */
  clearAllMutations: () => void;
  /** Manually bump mutation version (for bulk operations that bypass store) */
  bumpMutationVersion: () => void;
}

function generateChangeSetId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export const createMutationSlice: StateCreator<
  ViewerState,
  [],
  [],
  MutationSlice
> = (set, get) => ({
  // Initial state
  mutationViews: new Map(),
  changeSets: new Map(),
  activeChangeSetId: null,
  undoStacks: new Map(),
  redoStacks: new Map(),
  dirtyModels: new Set(),
  mutationVersion: 0,
  georefMutations: new Map(),

  // Georeferencing Mutations
  setGeorefField: (modelId, entity, field, value, oldValue) => {
    get().setGeorefFields(modelId, entity, [{ field, value, oldValue }]);
  },

  setGeorefFields: (modelId, entity, fields) => {
    if (fields.length === 0) return;
    set((state) => {
      const newGeorefMuts = new Map(state.georefMutations);
      const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
      const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
      for (const entry of fields) {
        entityMuts[entry.field] = entry.value;
      }
      newGeorefMuts.set(modelId, { ...modelMuts, [entity]: entityMuts });

      // Track undo
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      const nextMutations: Mutation[] = fields.map(entry => ({
        id: `mut_georef_${entity}_${entry.field}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'UPDATE_ATTRIBUTE',
        timestamp: Date.now(),
        modelId,
        entityId: 0, // georef entities don't map to a specific element
        attributeName: `georef.${entity}.${entry.field}`,
        oldValue: entry.oldValue,
        newValue: entry.value,
        propName: entry.field,
        psetName: entity,
      }));
      newUndoStacks.set(modelId, [...stack, ...nextMutations]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        georefMutations: newGeorefMuts,
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });
  },

  getGeorefMutations: (modelId) => {
    return get().georefMutations.get(modelId);
  },

  // Mutation View Management
  getMutationView: (modelId) => {
    return get().mutationViews.get(modelId) || null;
  },

  registerMutationView: (modelId, view) => {
    set((state) => {
      const newViews = new Map(state.mutationViews);
      newViews.set(modelId, view);
      return { mutationViews: newViews };
    });
  },

  clearMutationView: (modelId) => {
    set((state) => {
      const newViews = new Map(state.mutationViews);
      newViews.delete(modelId);
      const newDirty = new Set(state.dirtyModels);
      newDirty.delete(modelId);
      return { mutationViews: newViews, dirtyModels: newDirty };
    });
  },

  // Property Mutations
  setProperty: (modelId, entityId, psetName, propName, value, valueType = PropertyValueType.String) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setProperty(entityId, psetName, propName, value, valueType);

    set((state) => {
      // Add to undo stack
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      // Clear redo stack on new mutation
      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      // Mark model as dirty
      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  deleteProperty: (modelId, entityId, psetName, propName) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deleteProperty(entityId, psetName, propName);
    if (!mutation) return null;

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  createPropertySet: (modelId, entityId, psetName, properties) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createPropertySet(entityId, psetName, properties);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  deletePropertySet: (modelId, entityId, psetName) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deletePropertySet(entityId, psetName);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Quantity Mutations
  setQuantity: (modelId, entityId, qsetName, quantName, value, quantityType = QuantityType.Count, unit) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setQuantity(entityId, qsetName, quantName, value, quantityType, unit);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  createQuantitySet: (modelId, entityId, qsetName, quantities) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createQuantitySet(entityId, qsetName, quantities);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Attribute Mutations
  setAttribute: (modelId, entityId, attrName, value, oldValue) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setAttribute(entityId, attrName, value, oldValue);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Undo/Redo
  undo: (modelId) => {
    const state = get();
    const undoStack = state.undoStacks.get(modelId) || [];
    if (undoStack.length === 0) return;

    const mutation = undoStack[undoStack.length - 1];

    // Handle georef mutations directly on georefMutations map
    if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName?.startsWith('georef.')) {
      const parts = mutation.attributeName.split('.');
      const entity = parts[1] as 'projectedCRS' | 'mapConversion';
      const field = parts[2];
      set((s) => {
        const newGeorefMuts = new Map(s.georefMutations);
        const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
        const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
        if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
          entityMuts[field] = mutation.oldValue;
        } else {
          delete entityMuts[field];
        }
        if (Object.keys(entityMuts).length === 0) {
          delete modelMuts[entity];
        } else {
          modelMuts[entity] = entityMuts as typeof modelMuts[typeof entity];
        }
        if (Object.keys(modelMuts).length === 0) {
          newGeorefMuts.delete(modelId);
        } else {
          newGeorefMuts.set(modelId, modelMuts);
        }

        const newUndoStacks = new Map(s.undoStacks);
        newUndoStacks.set(modelId, undoStack.slice(0, -1));
        const newRedoStacks = new Map(s.redoStacks);
        const redoStack = newRedoStacks.get(modelId) || [];
        newRedoStacks.set(modelId, [...redoStack, mutation]);

        return {
          georefMutations: newGeorefMuts,
          undoStacks: newUndoStacks,
          redoStacks: newRedoStacks,
          mutationVersion: s.mutationVersion + 1,
        };
      });
      return;
    }

    const view = state.mutationViews.get(modelId);
    if (!view) return;

    // Apply inverse mutation (skipHistory=true to avoid polluting mutation history)
    if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
      if (mutation.oldValue === null && mutation.psetName && mutation.propName) {
        view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
      } else if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.oldValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'DELETE_PROPERTY') {
      if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.oldValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'CREATE_QUANTITY') {
      // Undo creation: remove the quantity mutation
      view.removeQuantityMutation(mutation.entityId, mutation.psetName!, mutation.propName);
    } else if (mutation.type === 'UPDATE_QUANTITY') {
      if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined && mutation.oldValue !== null) {
        view.setQuantity(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          Number(mutation.oldValue),
          undefined,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
      if (mutation.attributeName) {
        if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
          view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.oldValue), undefined, true);
        } else {
          view.removeAttributeMutation(mutation.entityId, mutation.attributeName);
        }
      }
    }

    set((s) => {
      const newUndoStacks = new Map(s.undoStacks);
      newUndoStacks.set(modelId, undoStack.slice(0, -1));

      const newRedoStacks = new Map(s.redoStacks);
      const redoStack = newRedoStacks.get(modelId) || [];
      newRedoStacks.set(modelId, [...redoStack, mutation]);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        mutationVersion: s.mutationVersion + 1,
      };
    });
  },

  redo: (modelId) => {
    const state = get();
    const redoStack = state.redoStacks.get(modelId) || [];
    if (redoStack.length === 0) return;

    const mutation = redoStack[redoStack.length - 1];

    // Handle georef mutations directly
    if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName?.startsWith('georef.')) {
      const parts = mutation.attributeName.split('.');
      const entity = parts[1] as 'projectedCRS' | 'mapConversion';
      const field = parts[2];
      set((s) => {
        const newGeorefMuts = new Map(s.georefMutations);
        const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
        const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
        if (mutation.newValue !== undefined && mutation.newValue !== null) {
          entityMuts[field] = mutation.newValue;
        } else {
          delete entityMuts[field];
        }
        if (Object.keys(entityMuts).length === 0) {
          delete modelMuts[entity];
        } else {
          modelMuts[entity] = entityMuts as typeof modelMuts[typeof entity];
        }
        if (Object.keys(modelMuts).length === 0) {
          newGeorefMuts.delete(modelId);
        } else {
          newGeorefMuts.set(modelId, modelMuts);
        }

        const newRedoStacks = new Map(s.redoStacks);
        newRedoStacks.set(modelId, redoStack.slice(0, -1));
        const newUndoStacks = new Map(s.undoStacks);
        const undoStack = newUndoStacks.get(modelId) || [];
        newUndoStacks.set(modelId, [...undoStack, mutation]);

        return {
          georefMutations: newGeorefMuts,
          undoStacks: newUndoStacks,
          redoStacks: newRedoStacks,
          mutationVersion: s.mutationVersion + 1,
        };
      });
      return;
    }

    const view = state.mutationViews.get(modelId);
    if (!view) return;

    // Re-apply mutation (skipHistory=true to avoid polluting mutation history)
    if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
      if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.newValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'DELETE_PROPERTY') {
      if (mutation.psetName && mutation.propName) {
        view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
      }
    } else if (mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY') {
      if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
        view.setQuantity(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          Number(mutation.newValue),
          undefined,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
      if (mutation.attributeName && mutation.newValue !== undefined) {
        view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.newValue), undefined, true);
      }
    }

    set((s) => {
      const newRedoStacks = new Map(s.redoStacks);
      newRedoStacks.set(modelId, redoStack.slice(0, -1));

      const newUndoStacks = new Map(s.undoStacks);
      const undoStack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...undoStack, mutation]);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        mutationVersion: s.mutationVersion + 1,
      };
    });
  },

  canUndo: (modelId) => {
    const stack = get().undoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

  canRedo: (modelId) => {
    const stack = get().redoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

  // Change Sets
  createChangeSet: (name) => {
    const id = generateChangeSetId();
    const changeSet: ChangeSet = {
      id,
      name,
      createdAt: Date.now(),
      mutations: [],
      applied: false,
    };

    set((state) => {
      const newChangeSets = new Map(state.changeSets);
      newChangeSets.set(id, changeSet);
      return { changeSets: newChangeSets, activeChangeSetId: id };
    });

    return id;
  },

  getActiveChangeSet: () => {
    const state = get();
    if (!state.activeChangeSetId) return null;
    return state.changeSets.get(state.activeChangeSetId) || null;
  },

  setActiveChangeSet: (id) => {
    set({ activeChangeSetId: id });
  },

  exportChangeSet: (id) => {
    const changeSet = get().changeSets.get(id);
    if (!changeSet) return null;

    return JSON.stringify({
      version: 1,
      changeSet,
      exportedAt: Date.now(),
    }, null, 2);
  },

  importChangeSet: (json) => {
    try {
      const data = JSON.parse(json);
      if (!data.changeSet) return;

      const changeSet: ChangeSet = {
        ...data.changeSet,
        id: generateChangeSetId(),
        applied: false,
      };

      set((state) => {
        const newChangeSets = new Map(state.changeSets);
        newChangeSets.set(changeSet.id, changeSet);
        return { changeSets: newChangeSets };
      });
    } catch {
      console.error('Failed to import change set');
    }
  },

  // Query
  hasChanges: (modelId) => {
    if (get().dirtyModels.has(modelId)) return true;
    // Schedule-only case: a generated schedule OR an edited parsed
    // schedule counts as a pending edit even if the user hasn't touched
    // any properties.
    const cross = get() as unknown as {
      scheduleSourceModelId?: string | null;
      scheduleIsEdited?: boolean;
      scheduleData?: { tasks: Array<{ expressId?: number }> } | null;
    };
    if (cross.scheduleSourceModelId !== modelId) return false;
    if (cross.scheduleIsEdited) return true;
    const tasks = cross.scheduleData?.tasks;
    if (!tasks) return false;
    for (const t of tasks) if (!t.expressId || t.expressId <= 0) return true;
    return false;
  },

  getMutationsForModel: (modelId) => {
    const view = get().mutationViews.get(modelId);
    return view ? view.getMutations() : [];
  },

  getModifiedEntityCount: () => {
    let count = 0;
    for (const view of get().mutationViews.values()) {
      count += view.getModifiedEntityCount();
    }
    // Include models with georef-only edits
    for (const [modelId, gm] of get().georefMutations) {
      const hasGeoref = (gm.projectedCRS && Object.keys(gm.projectedCRS).length > 0)
        || (gm.mapConversion && Object.keys(gm.mapConversion).length > 0);
      if (hasGeoref && !get().mutationViews.has(modelId)) {
        count += 1; // count the model as having modifications
      }
    }
    // Include generated schedule tasks — these are spliced into the STEP
    // export just like property mutations are, so they belong in the same
    // "pending changes" count the export badge reads.
    //
    // Edited parsed schedules: if the schedule has been edited (any task
    // renamed / rescheduled / deleted / etc.) count +1 to surface the
    // badge, even when no generated tasks exist. Users need some signal
    // that "edits are pending export"; a single +1 keeps the count
    // honest without inflating for every individual field change.
    const cross = get() as unknown as {
      scheduleData?: { tasks: Array<{ expressId?: number }> } | null;
      scheduleIsEdited?: boolean;
    };
    const tasks = cross.scheduleData?.tasks;
    let hasGenerated = false;
    if (tasks) {
      for (const t of tasks) {
        if (!t.expressId || t.expressId <= 0) {
          count++;
          hasGenerated = true;
        }
      }
    }
    if (cross.scheduleIsEdited && !hasGenerated) count++;
    return count;
  },

  // Reset
  clearMutations: (modelId) => {
    const view = get().mutationViews.get(modelId);
    if (view) {
      view.clear();
    }

    // Also discard pending schedule edits owned by this model. Done via
    // the schedule slice's own action so its invariants (range, playback,
    // expanded rows) stay consistent.
    const cross = get() as unknown as {
      scheduleSourceModelId?: string | null;
      clearGeneratedSchedule?: () => number;
    };
    if (cross.scheduleSourceModelId === modelId && cross.clearGeneratedSchedule) {
      cross.clearGeneratedSchedule();
    }

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      newUndoStacks.delete(modelId);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.delete(modelId);

      const newDirty = new Set(state.dirtyModels);
      newDirty.delete(modelId);

      const newGeorefMuts = new Map(state.georefMutations);
      newGeorefMuts.delete(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        georefMutations: newGeorefMuts,
        mutationVersion: state.mutationVersion + 1,
      };
    });
  },

  clearAllMutations: () => {
    for (const view of get().mutationViews.values()) {
      view.clear();
    }

    // Schedule slice handles its own state transitions.
    const cross = get() as unknown as { clearGeneratedSchedule?: () => number };
    cross.clearGeneratedSchedule?.();

    set((state) => ({
      undoStacks: new Map(),
      redoStacks: new Map(),
      dirtyModels: new Set(),
      georefMutations: new Map(),
      mutationVersion: state.mutationVersion + 1,
    }));
  },

  bumpMutationVersion: () => {
    set((state) => ({
      mutationVersion: state.mutationVersion + 1,
    }));
  },
});
