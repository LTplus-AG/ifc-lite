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
import type { EntityRef, FederatedModel } from '../types.js';
import { stringToEntityRef } from '../types.js';
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

/** The clash actions a model-lifecycle teardown reaches for, all optional: the
 *  slice's own tests drive these actions through a harness that stubs `get()`
 *  with the model slice alone. */
interface ClashSceneTeardown {
  clearClashFocus?: () => void;
  clearClash?: () => void;
  clearGhost?: () => void;
}

/**
 * End the clash presentation a model-lifecycle path is about to invalidate —
 * the ONE spelling of it, so a third teardown path added tomorrow is complete
 * by construction rather than by remembering a field list (#2654 review).
 *
 * Two halves, because the presentation lives in two slices:
 *
 *  - the clash slice's own focus fields (solid, pair tint, contact marker,
 *    selected id, `clashSolidRequestSeq` bump) via `clearClashFocus` /
 *    `clearClash`, the slice's complete spellings of that teardown;
 *  - the SHARED ghost channel (`ghostExceptEntities`, visibilitySlice), which
 *    `focusClash` also takes ownership of: an `X-Ray` focus mode ghosts the
 *    pair's context, and the resolved-solid path ghosts the ENTIRE model
 *    (`installClashGhost(new Set())`, useClash.ts). Neither clash action can
 *    reach it, so before this every model-lifecycle teardown left the scene
 *    fully translucent with nothing selected and no way to tell why (#2654).
 *
 * `ghostExceptEntities` deliberately does NOT live in the clash slice's
 * `CLASH_FOCUS_RESET`: `clearClashFocus()` is ALSO called at RUN START
 * (`useClash.discardSolidPresentation`), where the ghost must be released
 * ownership-aware (`releaseClashVisibility`, content-matched against the
 * install record) so a user's spaces X-ray survives pressing Run — #2662 P2.
 * Adding the field to that constant fails
 * `useClash.run-preserves-isolation.test.tsx` ("a user-established X-ray ghost
 * SURVIVES run()"), verified.
 *
 * Here the clear is UNCONDITIONAL, which is what every other USER-INITIATED
 * end of a focus already does — the panel's Clear button
 * (`useClash.clearHighlight`), the panel unmount cleanup (`ClashPanel`), the
 * clash tour cleanup and `resetViewerState` all pair the clash-focus clear
 * with a bare `clearGhost()`. Ownership-aware release is the exception, and it
 * exists for exactly one situation: an implicit teardown incidental to
 * STARTING a computation the user did not aim at the view. Removing a model is
 * the user changing the scene, and this cannot consult the install record
 * anyway — it is a `useRef` private to a `useClash()` instance. The trade is
 * the one `removeModel` already accepts for the focus itself: losing an
 * unrelated X-ray on a model removal is cheap; leaving the survivors ghosted
 * with nothing selected is not.
 */
function endClashScenePresentation(cross: ClashSceneTeardown, dropResult: boolean): void {
  if (dropResult) cross.clearClash?.();
  else cross.clearClashFocus?.();
  cross.clearGhost?.();
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

  removeModel: (modelId) => {
    // Discard the removed model's mutation footprint before dropping it.
    // Otherwise its mutation view, georef edits, undo/redo stacks and any
    // schedule it owns linger in the store: getModifiedEntityCount keeps
    // counting a model that can no longer be exported, and a schedule whose
    // source model is gone dangles. clearMutations empties the view + stacks +
    // georef (and clears an owned schedule); clearMutationView then drops the
    // now-empty view entry so the count stops iterating it. Both are existing,
    // separately-tested actions on the mutation slice (cross-slice via get()).
    const cross = get() as unknown as {
      clearMutations?: (id: string) => void;
      clearMutationView?: (id: string) => void;
      clearGeneratedSchedule?: () => number;
      idsValidationReport?: { modelInfo: { modelId: string } } | null;
      clearIdsValidationReport?: () => void;
      removeSourceTag?: (id: string) => void;
    } & ClashSceneTeardown;
    cross.clearMutations?.(modelId);
    cross.clearMutationView?.(modelId);
    // Drop the model's cloud-source provenance tag (sourcesSlice) so the
    // sources UI stops offering "Sync from source" for a model that no
    // longer exists and the tag map cannot grow without bound.
    cross.removeSourceTag?.(modelId);

    // Drop the focused-clash PRESENTATION — the A/B pair tint, the contact
    // marker (lines + AABB box) and the on-demand intersection solid, all of
    // them geometry drawn into the live scene against a model set that is
    // changing under it (#2654 review). Via `clearClashFocus`, the clash
    // slice's single complete spelling of that teardown: clearing the solid and
    // the selected id by hand — as this did — left `clashContactLines` /
    // `clashOverlapBox` set, and `Viewport`'s marker effect is keyed on those
    // alone, so the wireframe stayed drawn over models that were gone.
    // Unconditional, not "only if the
    // focused clash names this model": a clash id is `${ruleId} ${lo} ${hi}`
    // with `lo`/`hi` themselves `model:expressId`, and parsing it here would be
    // a third, subtly different reading of a key format — the exact hazard the
    // selection purge below calls out and routes through `stringToEntityRef`
    // to avoid. Losing a highlight on an unrelated model's removal is cheap;
    // an orphaned opaque solid over the survivors is not.
    //
    // The clash RESULT is deliberately kept: it is a list the user is reading,
    // not something rendered into the scene, and a federated sibling leaving
    // does not invalidate the pairs that do not involve it. Full teardown
    // (`clearAllModels`, `resetViewerState`) drops the result as well.
    //
    // `clearClashFocus` bumps `clashSolidRequestSeq`, so an in-flight compute
    // cannot land after this and repaint the solid. The shared helper adds the
    // half neither clash action can reach — the ghost channel `focusClash`
    // also owns; see its doc for why that clear is unconditional here and
    // ownership-aware at run start.
    endClashScenePresentation(cross, false);

    // If the removed model is the one the current IDS report describes, that
    // report is stale by definition — its results reference a model that no
    // longer exists, and the panel's controlled model picker would bind to a
    // now-missing option. Drop it so the panel self-heals (#1702 C2).
    if (cross.idsValidationReport?.modelInfo.modelId === modelId) {
      cross.clearIdsValidationReport?.();
    }

    // clearMutations only clears a schedule whose source === modelId. Removing
    // the last model orphans any remaining schedule (e.g. one with a null /
    // dangling source), which would keep inflating getModifiedEntityCount with
    // no model left to own it — so drop its generated tasks once the federation
    // is empty.
    const models = get().models;
    if (models.size <= 1 && models.has(modelId)) {
      cross.clearGeneratedSchedule?.();
      // Removing the final model empties the federation. Any surviving report
      // (e.g. one whose stored target is the '__legacy__' sentinel, which can
      // never match a real model id above) now references nothing loaded, so
      // drop it regardless of its stored target id.
      cross.clearIdsValidationReport?.();
    }

    set((state) => {
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

      // Selection state keys off modelId, so anything pointing at the removed
      // model is now dangling: `models.get(selectedEntity.modelId)` returns
      // undefined and the properties panel silently renders nothing rather
      // than re-resolving, leaving a ghost selection until the user clicks
      // elsewhere. `activeStorey` likewise stays pinned to a storey in a model
      // that no longer exists, which the Solo level display and floorplan read.
      //
      // `syncSourceModel`'s purgeStaleReferences already does exactly this for
      // the same-modelId resync path; full removal needed the same treatment
      // and never got it. Entries belonging to OTHER models are preserved —
      // clearing wholesale would drop a federated sibling's live selection.
      // Selection lives on selectionSlice; reached through a narrow cast the
      // same way the mutation/IDS/source-tag actions above are reached via
      // `cross`, since a slice's own StateCreator is typed to its own fields.
      // Every field is optional here, not just cast: `modelSlice.test.ts`
      // drives this action through a harness that stubs `set`/`get` with the
      // model slice alone, so selection fields are genuinely absent there. A
      // slice reaching across must tolerate that rather than assume the
      // combined store.
      const sel = state as unknown as Partial<{
        selectedEntity: EntityRef | null;
        activeStorey: EntityRef | null;
        selectedEntities: EntityRef[];
        selectedEntitiesSet: Set<string>;
        selectedModelId: string | null;
      }>;
      const priorEntities = sel.selectedEntities ?? [];
      const priorSet = sel.selectedEntitiesSet ?? new Set<string>();
      const keptEntities = priorEntities.filter((e) => e.modelId !== modelId);
      const selectionTouchedRemoved =
        sel.selectedEntity?.modelId === modelId ||
        sel.activeStorey?.modelId === modelId ||
        keptEntities.length !== priorEntities.length;

      return {
        models: newModels,
        activeModelId: newActiveId,
        ifcDataStore: activeModel?.ifcDataStore ?? null,
        geometryResult: activeModel?.geometryResult ?? null,
        ...(selectionTouchedRemoved
          ? {
              selectedEntity:
                sel.selectedEntity?.modelId === modelId ? null : sel.selectedEntity,
              activeStorey: sel.activeStorey?.modelId === modelId ? null : sel.activeStorey,
              selectedEntities: keptEntities,
              // Parsed with the shared helper rather than a `${modelId}:`
              // prefix test: `stringToEntityRef` splits on the FIRST colon, so
              // a prefix match would also strip a sibling model whose id
              // merely starts with this one's id plus a colon. Using the same
              // parse every other consumer uses keeps this filter from
              // becoming a third, subtly different reading of the same key.
              selectedEntitiesSet: new Set(
                [...priorSet].filter(
                  (k) => stringToEntityRef(k).modelId !== modelId
                )
              ),
              selectedModelId: sel.selectedModelId === modelId ? null : (sel.selectedModelId ?? null),
            }
          : {}),
      };
    });
  },

  clearAllModels: () => {
    // Full federation teardown: any IDS report now references an unloaded
    // model, so drop it too (removeModel's per-model cleanup never runs here).
    // Same for the cloud-source provenance tags — every tagged model is gone.
    const crossClear = get() as unknown as {
      clearIdsValidationReport?: () => void;
      clearSourceTags?: () => void;
    } & ClashSceneTeardown;
    crossClear.clearIdsValidationReport?.();
    crossClear.clearSourceTags?.();
    // A clash run describes pairs of elements in models that are all about to
    // be gone, and the on-demand intersection SOLID is a mesh drawn into the
    // live scene — `Viewport`'s draw gate reads `clashSelectedId` +
    // `clashSolidStatus`, neither of which any model-lifecycle path used to
    // touch (#2654 review). `clearClash` drops both and bumps
    // `clashSolidRequestSeq`, so an in-flight compute cannot land afterwards.
    // Presets + settings are workspace prefs and survive, as everywhere else.
    // Through the shared helper so the ghost `focusClash` installs goes too —
    // with every model unloaded there is nothing left for it to fade, and
    // `resetViewerState` (store/index.ts) has always nulled it here.
    endClashScenePresentation(crossClear, true);
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
