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
import {
  endClashScenePresentation,
  type ClashSceneTeardown,
} from '@/lib/clash/visibility-ownership';

/**
 * Cross-slice fields the model actions write to. `ifcDataStore` and
 * `geometryResult` are owned by `dataSlice` but `modelSlice`'s set()
 * calls need to keep them in sync with the active model.
 */
export interface ModelCrossSliceState {
  ifcDataStore: IfcDataStore | null;
  geometryResult: GeometryResult | null;
  /** AddElement panel's target-model pin (addElementSlice) — cleared here on
   *  full teardown for the same reason `removeModel` clears it when it names
   *  the one model being removed. See that call site's comment. */
  addElementModelId: string | null;
  addElementStoreyId: number | null;
  /** Global-id state `removeModel`/`clearAllModels` purge of ids the removed
   *  model(s) owned — same shape as `syncSourceModel.ts`'s
   *  `purgeStaleEntityState`, run here for the full-removal path it never
   *  covered. See `removeModel`'s comment for why. */
  selectedEntityId: number | null;
  selectedEntityIds: Set<number>;
  selectedStoreys: Set<number>;
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  ghostExceptEntities: Set<number> | null;
  classFilter: { ids: Set<number>; label: string } | null;
  hiddenEntitiesByModel: Map<string, Set<number>>;
  isolatedEntitiesByModel: Map<string, Set<number>>;
  /** Pinboard/basket state (pinboardSlice) `removeModel`/`clearAllModels`
   *  purge of refs the removed model(s) owned — same entityRef-string
   *  keying as `selectedEntitiesSet`. See `removeModel`'s comment for why. */
  pinboardEntities: Set<string>;
  hierarchyBasketSelection: Set<string>;
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

  /**
   * The same resolution as {@link resolveGlobalIdFromModels}, SCOPED to one
   * named model: "does this model own this global id, and as which local
   * express id?".
   *
   * For a caller that already knows the owner — a clash ref carries the model
   * it was gathered from — searching every model is not just wasted work, it is
   * wrong: two models' ranges can overlap (a collab room model and a normally
   * loaded one both sit at offset 0), and the search answers with whichever it
   * reaches first. Scoping removes that ambiguity.
   *
   * It shares the range and overlay predicates with the unscoped resolver
   * above, so the two cannot drift — a private range check in a caller is how
   * this codebase produced two resolvers that disagreed about the same id space
   * (#2697).
   *
   * Not the only spelling in the repo, and this doc must not claim otherwise:
   * `store/globalId.ts` `fromGlobalIdFromModels` holds an independent copy that
   * deliberately differs — it does not sort by `idOffset`, and it has a
   * single-model fallback that answers even when the range check misses, for
   * legacy single-store behaviour. Unifying them is a separate change with its
   * own risk; what this pair guarantees is that the SCOPED and UNSCOPED
   * resolvers on this slice always agree.
   */
  resolveGlobalIdInModel: (modelId: string, globalId: number) => GlobalIdLookup | null;
}

/**
 * Parse-time ownership: a model owns `[idOffset, idOffset + maxExpressId]` from
 * the original parse. Returns the LOCAL express id, or `null`.
 *
 * `model.idOffset` bare, no `?? 0`: it is a required `number` on
 * `FederatedModel` (`store/types.ts`), and the unscoped resolver this is
 * extracted from has always read it bare. `null` is returned for a miss, so a
 * caller must test `!== null` — local id `0` is a legitimate answer and a
 * truthiness test would drop it.
 */
function localIdInParseRange(model: FederatedModel, globalId: number): number | null {
  const localId = globalId - model.idOffset;
  return localId >= 0 && localId <= model.maxExpressId ? localId : null;
}

/**
 * Overlay ownership: duplicates / scripted adds through StoreEditor land ABOVE
 * the model's parse-time `maxExpressId`, so `localIdInParseRange` cannot see
 * them; the model's mutation view can. Returns the LOCAL express id, or `null`.
 */
function localIdInOverlay(
  model: FederatedModel,
  globalId: number,
  view: { getNewEntity: (id: number) => unknown } | undefined,
): number | null {
  if (!view) return null;
  const localId = globalId - model.idOffset;
  if (localId <= model.maxExpressId) return null; // parse-range's business
  return view.getNewEntity(localId) !== null ? localId : null;
}

/** The mutation views registered on the store, if the owning slice is present. */
function mutationViewsOf(
  state: unknown,
): Map<string, { getNewEntity: (id: number) => unknown }> | undefined {
  return (state as { mutationViews?: Map<string, { getNewEntity: (id: number) => unknown }> }).mutationViews;
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
    // A removal that removes nothing must do nothing. `syncSourceModel` and the
    // collab room teardown can both re-enter with an id that has already gone,
    // and every cleanup below is keyed to THIS model — but the clash teardown
    // is not, so a stale id used to drop the user's focused clash, its solid
    // and its ghost as the side effect of a no-op (#2654 second review). Same
    // shape, and the same guard, as `updateModel` above.
    if (!get().models.has(modelId)) return;

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
      pointCloudDeviationComputed?: boolean;
      setPointCloudDeviationComputed?: (computed: boolean) => void;
    };
    cross.clearMutations?.(modelId);
    cross.clearMutationView?.(modelId);
    // Drop the model's cloud-source provenance tag (sourcesSlice) so the
    // sources UI stops offering "Sync from source" for a model that no
    // longer exists and the tag map cannot grow without bound.
    cross.removeSourceTag?.(modelId);
    // A computed BIM<->scan deviation heatmap (`DeviationPanel`) is built from
    // a BVH over EVERY triangle in the scene (`DeviationComputer.compute`,
    // packages/renderer) -- not scoped to this model -- so removing any
    // federated model invalidates it exactly like the clash focus and IDS
    // report above. `pointCloudDeviationComputed` gates the panel's own
    // auto-recompute effect, so leaving it `true` here would leave the
    // slider/legend presenting a heatmap computed against a triangle set that
    // no longer exists, with nothing left to trigger a rebuild.
    if (cross.pointCloudDeviationComputed) {
      cross.setPointCloudDeviationComputed?.(false);
    }

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
    // two channels neither clash action can reach — the isolate/ghost channels
    // `focusClash` also owns (released against `clashVisibilityOwned`, clash's
    // OWN record, not inferred from the selection), and the colour-override
    // channel that actually carries the pair tint; see its doc.
    //
    // Re-`get()` rather than reusing `cross`: `clearMutations` /
    // `clearMutationView` / `removeSourceTag` above each commit a new state
    // object, so a snapshot taken before them would read ownership off a
    // pre-mutation object. None of them touches a field the helper reads today
    // — verified against `mutationSlice.clearMutations` — but that is a
    // property of today's implementations, not of this call site.
    endClashScenePresentation(() => get() as unknown as ClashSceneTeardown, 'model-removed');

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
    // `models.has(modelId)` is not re-tested here: the early return at the top
    // already established it, and nothing between can add or remove a model.
    // Keeping it read as a live condition when it is a tautology.
    if (get().models.size <= 1) {
      cross.clearGeneratedSchedule?.();
      // Removing the final model empties the federation. Any surviving report
      // (e.g. one whose stored target is the '__legacy__' sentinel, which can
      // never match a real model id above) now references nothing loaded, so
      // drop it regardless of its stored target id.
      cross.clearIdsValidationReport?.();
    }

    // A published compare result (compareSlice) names its base/head models by
    // id and its `excludedHiddenIds` / `diff` entries carry federation GLOBAL
    // ids computed against those two models' offsets. If the removed model
    // was either side of that comparison, the result no longer describes a
    // pairing that exists — same dangling-reference shape as the IDS report
    // above, one slice over. Left alone it merely dangles here (removeModel
    // never resets `federationRegistry`'s offset counter, so no later model
    // can be re-assigned these same ids) but `clearAllModels` below does not
    // have that guarantee, so this call site exists for symmetry and so a
    // partial federation edit (remove one side of a compare, add a
    // replacement) can't leave a comparison silently describing the old
    // pairing while a new one of the same shape loads.
    const compareCross = get() as unknown as {
      compareResult?: { baseModelId: string; headModelId: string } | null;
      clearCompare?: () => void;
    };
    if (
      compareCross.compareResult &&
      (compareCross.compareResult.baseModelId === modelId || compareCross.compareResult.headModelId === modelId)
    ) {
      compareCross.clearCompare?.();
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
        addElementModelId: string | null;
        addElementStoreyId: number | null;
        selectedEntityId: number | null;
        selectedEntityIds: Set<number>;
        selectedStoreys: Set<number>;
        hiddenEntities: Set<number>;
        isolatedEntities: Set<number> | null;
        ghostExceptEntities: Set<number> | null;
        classFilter: { ids: Set<number>; label: string } | null;
        hiddenEntitiesByModel: Map<string, Set<number>>;
        isolatedEntitiesByModel: Map<string, Set<number>>;
        mutationViews: Map<string, { getNewEntity: (id: number) => unknown }>;
        pinboardEntities: Set<string>;
        hierarchyBasketSelection: Set<string>;
      }>;
      const priorEntities = sel.selectedEntities ?? [];
      const priorSet = sel.selectedEntitiesSet ?? new Set<string>();
      const keptEntities = priorEntities.filter((e) => e.modelId !== modelId);
      const selectionTouchedRemoved =
        sel.selectedEntity?.modelId === modelId ||
        sel.activeStorey?.modelId === modelId ||
        keptEntities.length !== priorEntities.length;

      // Global-id sets (selection, hidden, isolated, ghost, class filter) key
      // off `globalId`, not `modelId` — they don't carry which model an id
      // belongs to the way `EntityRef`-shaped state above does. A global id
      // is "stale" once no SURVIVING model's parse range or overlay owns it
      // (mirrors `syncSourceModel.ts`'s `purgeStaleEntityState`, the same
      // check the resync path already runs after a model swap; full removal
      // never got it, matching the gap `addElementModelId` had above — same
      // dangling-reference shape, more fields). Left unpurged, an isolate or
      // ghost set that only ever named the removed model's entities stays
      // non-null while matching nothing in the survivors, so
      // `effectiveIsolatedIds` keeps returning it and the entire remaining
      // federation renders as hidden — worse than the id merely dangling.
      const survivors = Array.from(newModels.values());
      const mutationViews = sel.mutationViews;
      const isStale = (id: number): boolean => {
        for (const survivor of survivors) {
          const localId = id - survivor.idOffset;
          if (localId < 0) continue;
          if (localId <= survivor.maxExpressId) return false;
          if (mutationViews?.get(survivor.id)?.getNewEntity(localId) != null) return false;
        }
        return true;
      };
      const priorSelectedEntityIds = sel.selectedEntityIds;
      const priorSelectedStoreys = sel.selectedStoreys;
      const priorHiddenEntities = sel.hiddenEntities;
      const priorIsolatedEntities = sel.isolatedEntities;
      const priorGhostEntities = sel.ghostExceptEntities;
      const priorClassFilter = sel.classFilter;
      const globalIdStateTouchedRemoved =
        (priorSelectedEntityIds && [...priorSelectedEntityIds].some(isStale)) ||
        (priorSelectedStoreys && [...priorSelectedStoreys].some(isStale)) ||
        (priorHiddenEntities && [...priorHiddenEntities].some(isStale)) ||
        (priorIsolatedEntities && [...priorIsolatedEntities].some(isStale)) ||
        (priorGhostEntities && [...priorGhostEntities].some(isStale)) ||
        (priorClassFilter && [...priorClassFilter.ids].some(isStale)) ||
        (sel.selectedEntityId !== undefined && sel.selectedEntityId !== null && isStale(sel.selectedEntityId)) ||
        sel.hiddenEntitiesByModel?.has(modelId) ||
        sel.isolatedEntitiesByModel?.has(modelId);

      // The AddElement panel's "target model" pin (addElementSlice) is the
      // same shape of dangling reference as the selection fields above, just
      // on a different slice: `addElementModelId` names a specific federated
      // model so the panel and the click-placement handlers
      // (`resolveAddElementContext` in selectionHandlers.ts) stop tracking
      // whichever model is merely active. Nothing else clears it when that
      // model goes away, so it keeps naming a model no longer in `models`
      // after removal — the panel's Select renders blank instead of falling
      // back to the active model, and every subsequent placement click fails
      // with "No model loaded for id" until the user re-picks a model by
      // hand. `addElementStoreyId` is an express id local to that same
      // model, so it is stale too and reset alongside it; it is left alone
      // when the pin names a different (surviving) model, matching how
      // `selectedEntities` above only drops entries that belong to the
      // removed model.
      const addElementTouchedRemoved = sel.addElementModelId === modelId;

      // Pinboard/basket state (pinboardSlice) is keyed the same way as
      // `selectedEntitiesSet` above -- Set<string> of "modelId:expressId"
      // entityRef strings -- but was never purged here. `pinboardEntities`
      // is documented in pinboardSlice.ts as the basket's SOURCE OF TRUTH:
      // every basket edit (`addToBasket`/`removeFromBasket`/`showPinboard`)
      // re-derives `isolatedEntities` from it via `toGlobalIdForRef`, and
      // `toGlobalIdFromModels` falls back to the RAW, un-offset expressId
      // when a ref's modelId is no longer in `models`. A stale ref surviving
      // removal therefore doesn't just dangle inertly: the next basket
      // operation resolves it to a bare, unscaled global id that can collide
      // with a real entity in any surviving model whose own offset range
      // covers that raw number (any model with idOffset 0, notably) --
      // silently co-isolating or co-hiding an entity the user never touched.
      const priorPinboard = sel.pinboardEntities ?? new Set<string>();
      const priorHierarchyBasket = sel.hierarchyBasketSelection ?? new Set<string>();
      const keptPinboard = new Set(
        [...priorPinboard].filter((k) => stringToEntityRef(k).modelId !== modelId)
      );
      const keptHierarchyBasket = new Set(
        [...priorHierarchyBasket].filter((k) => stringToEntityRef(k).modelId !== modelId)
      );
      const pinboardTouchedRemoved =
        keptPinboard.size !== priorPinboard.size || keptHierarchyBasket.size !== priorHierarchyBasket.size;

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
        ...(addElementTouchedRemoved
          ? { addElementModelId: null, addElementStoreyId: null }
          : {}),
        ...(globalIdStateTouchedRemoved
          ? {
              selectedEntityId:
                sel.selectedEntityId != null && isStale(sel.selectedEntityId) ? null : sel.selectedEntityId,
              selectedEntityIds: priorSelectedEntityIds
                ? new Set([...priorSelectedEntityIds].filter((id) => !isStale(id)))
                : priorSelectedEntityIds,
              selectedStoreys: priorSelectedStoreys
                ? new Set([...priorSelectedStoreys].filter((id) => !isStale(id)))
                : priorSelectedStoreys,
              hiddenEntities: priorHiddenEntities
                ? new Set([...priorHiddenEntities].filter((id) => !isStale(id)))
                : priorHiddenEntities,
              // An isolate/ghost set left with zero surviving ids must clear
              // to `null` outright, not an empty `Set` — a non-null empty set
              // still reads as "isolation active, nothing matches" and hides
              // every remaining entity, same as the stale set it replaces.
              isolatedEntities: priorIsolatedEntities
                ? (() => {
                    const kept = new Set([...priorIsolatedEntities].filter((id) => !isStale(id)));
                    return kept.size > 0 ? kept : null;
                  })()
                : priorIsolatedEntities,
              ghostExceptEntities: priorGhostEntities
                ? (() => {
                    const kept = new Set([...priorGhostEntities].filter((id) => !isStale(id)));
                    return kept.size > 0 ? kept : null;
                  })()
                : priorGhostEntities,
              classFilter: priorClassFilter
                ? (() => {
                    const kept = new Set([...priorClassFilter.ids].filter((id) => !isStale(id)));
                    return kept.size > 0 ? { ids: kept, label: priorClassFilter.label } : null;
                  })()
                : priorClassFilter,
              hiddenEntitiesByModel: sel.hiddenEntitiesByModel
                ? (() => {
                    const next = new Map(sel.hiddenEntitiesByModel);
                    next.delete(modelId);
                    return next;
                  })()
                : sel.hiddenEntitiesByModel,
              isolatedEntitiesByModel: sel.isolatedEntitiesByModel
                ? (() => {
                    const next = new Map(sel.isolatedEntitiesByModel);
                    next.delete(modelId);
                    return next;
                  })()
                : sel.isolatedEntitiesByModel,
            }
          : {}),
        ...(pinboardTouchedRemoved
          ? { pinboardEntities: keptPinboard, hierarchyBasketSelection: keptHierarchyBasket }
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
      pointCloudDeviationComputed?: boolean;
      setPointCloudDeviationComputed?: (computed: boolean) => void;
    };
    crossClear.clearIdsValidationReport?.();
    crossClear.clearSourceTags?.();
    // Same staleness as `removeModel` above, for the full-teardown path.
    if (crossClear.pointCloudDeviationComputed) {
      crossClear.setPointCloudDeviationComputed?.(false);
    }
    // A clash run describes pairs of elements in models that are all about to
    // be gone, and the on-demand intersection SOLID is a mesh drawn into the
    // live scene — `Viewport`'s draw gate reads `clashSelectedId` +
    // `clashSolidStatus`, neither of which any model-lifecycle path used to
    // touch (#2654 review). `clearClash` drops both and bumps
    // `clashSolidRequestSeq`, so an in-flight compute cannot land afterwards.
    // Presets + settings are workspace prefs and survive, as everywhere else.
    // Through the shared helper so the isolate/ghost `focusClash` installs and
    // the pair tint it paints go too — with every model unloaded there is
    // nothing left for either to refer to, and `resetViewerState`
    // (store/index.ts) has always nulled the visibility fields here.
    endClashScenePresentation(() => get() as unknown as ClashSceneTeardown, 'federation-cleared');
    // Clear the federation registry
    federationRegistry.clear();
    // Same dangling reference as `removeModel`'s `addElementModelId` cleanup
    // above, just for every model at once: with `models` about to become
    // empty there is no federated model left for the AddElement panel's pin
    // to name, so it and the model-local storey id go too. Same for every
    // global-id set `removeModel` purges by range (selection, hidden,
    // isolated, ghost, class filter, and the per-model maps): with zero
    // survivors every id in them is stale by definition, so this unconditionally
    // clears them rather than repeating the range check for an always-true
    // answer. `isolatedEntities`/`ghostExceptEntities` clear to `null` (not an
    // empty `Set`) for the same reason `removeModel` does — an empty-but-set
    // isolate would hide the very next model loaded, until it does.
    // `federationRegistry.clear()` above resets the offset counter to 0, so
    // the very next model registered can be handed the exact offsets any
    // surviving compare result's `excludedHiddenIds` / `diff` global ids
    // describe (see `removeModel-compare-stale.test.ts`: a georef-triggered
    // reload calls `clearAllModels()` then reloads every model, and the
    // first one back gets offset 0 again). Unconditional, unlike
    // `removeModel`'s guarded version above — with every model gone there is
    // no pairing left for a compare result to describe either way, and here
    // the offset-reuse hazard makes leaving it behind actively dangerous
    // rather than merely stale.
    (get() as unknown as { clearCompare?: () => void }).clearCompare?.();
    // Same offset-reuse hazard, on the lens channel: `useLens.ts`'s effect
    // deps are `[activeLensId, activeLens]`, NOT `models` — a model
    // add/remove never re-evaluates the active lens, so `lensColorMap`,
    // `lensHiddenIds`, `lensAppliedColors`, `lensRuleCounts` and
    // `lensRuleEntityIds` keep naming whatever global ids they were last
    // computed against. `resetViewerState` (store/index.ts) already
    // deactivates the lens and clears these on every ordinary file load; the
    // gap is the same one `compareResult` had above — the georef-reload path
    // (`GeoreferencingPanel.tsx`'s `reloadModelsForAlignment`) calls only
    // `clearAllModels()`, never `resetViewerState()`, and the reload that
    // follows can hand the first model back offset 0. A lens still "active"
    // across that reload would then apply its stale hide/colour ids to
    // whatever entities the new federation assigned those same global ids —
    // hiding or tinting elements the user never touched. Guarded on
    // `activeLensId` so a clear with no lens ever active is a no-op, same
    // shape as `removeModel`'s `compareCross` guard above.
    const lensCross = get() as unknown as {
      activeLensId?: string | null;
      setActiveLens?: (id: string | null) => void;
      setLensColorMap?: (m: Map<number, string>) => void;
      setLensAppliedColors?: (m: Map<number, [number, number, number, number]> | null) => void;
      setLensHiddenIds?: (s: Set<number>) => void;
      setLensAppliedHiddenIds?: (ids: number[]) => void;
      setLensRuleIsolation?: (v: { ruleId: string; entityIds: number[] } | null) => void;
      setLensRuleCounts?: (m: Map<string, number>) => void;
      setLensRuleEntityIds?: (m: Map<string, number[]>) => void;
      setLensAutoColorLegend?: (legend: unknown[]) => void;
    };
    if (lensCross.activeLensId != null) {
      lensCross.setActiveLens?.(null);
      lensCross.setLensColorMap?.(new Map());
      lensCross.setLensAppliedColors?.(null);
      lensCross.setLensHiddenIds?.(new Set());
      lensCross.setLensAppliedHiddenIds?.([]);
      lensCross.setLensRuleIsolation?.(null);
      lensCross.setLensRuleCounts?.(new Map());
      lensCross.setLensRuleEntityIds?.(new Map());
      lensCross.setLensAutoColorLegend?.([]);
    }
    return set({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: null,
      geometryResult: null,
      addElementModelId: null,
      addElementStoreyId: null,
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      selectedStoreys: new Set(),
      hiddenEntities: new Set(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),
      // Same dangling-ref shape as `removeModel`'s pinboard purge above, for
      // the full-teardown path: with every model gone, every basket ref is
      // stale by definition.
      pinboardEntities: new Set(),
      hierarchyBasketSelection: new Set(),
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
    const mutationViews = mutationViewsOf(get());

    // Sort models by offset for correct range checking
    const sortedModels = Array.from(models.values()).sort((a, b) => a.idOffset - b.idOffset);

    // Find the model that contains this globalId.
    //
    // First pass — parse-time range (`localIdInParseRange`). The fast path
    // covering 99% of selections.
    //
    // Second pass — overlay-allocated ids (`localIdInOverlay`). Kept a
    // SEPARATE pass, not folded into a per-model "parse-range or overlay"
    // test: every model's parse range must be tried before any model's
    // overlay, or an overlay id of the first model could shadow a plain
    // parse-time id of the second.
    for (const model of sortedModels) {
      const localId = localIdInParseRange(model, globalId);
      if (localId !== null) return { modelId: model.id, expressId: localId };
    }

    for (const model of sortedModels) {
      const localId = localIdInOverlay(model, globalId, mutationViews?.get(model.id));
      if (localId !== null) return { modelId: model.id, expressId: localId };
    }

    return null;
  },

  resolveGlobalIdInModel: (modelId: string, globalId: number) => {
    const model = get().models.get(modelId);
    if (!model) return null;
    // Same two rules as the unscoped resolver, in the same order — there is
    // only one model to try, so the two passes collapse into two calls.
    const parsed = localIdInParseRange(model, globalId);
    if (parsed !== null) return { modelId, expressId: parsed };
    const overlay = localIdInOverlay(model, globalId, mutationViewsOf(get())?.get(modelId));
    if (overlay !== null) return { modelId, expressId: overlay };
    return null;
  },
});
