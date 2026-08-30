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
import { federationRegistry, type GlobalIdLookup } from '@ifc-lite/renderer';
import type { ViewerState } from '../index.js';
import { localIdInParseRange, localIdInOverlay } from '../globalId.js';
import { viewerTeardown } from '../teardown-registry.js';
import { modelRemovedScope } from '../teardown-scope.js';
import {
  endIdsRowFocusPresentation,
  type IDSRowFocusPresentation,
} from '../../lib/ids/visibility-ownership.js';
import {
  endClashScenePresentation,
  type ClashSceneTeardown,
} from '@/lib/clash/visibility-ownership';

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
   * (#2697). Those predicates (`localIdInParseRange` / `localIdInOverlay`) live
   * in `store/globalId.ts`, the same functions `teardown-scope.ts`'s
   * `modelRemovedScope` calls for its survivor check (#3343).
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
 * `localIdInParseRange` / `localIdInOverlay` live in `store/globalId.ts` now
 * (#3343) — that is the cycle-free home for the "does a surviving model own
 * this global id" rule shared with `teardown-scope.ts`'s `modelRemovedScope`.
 * They used to be defined here; keep this pointer so a reader who remembers
 * that lands in the right file.
 */

/** The mutation views registered on the store, if the owning slice is present. */
function mutationViewsOf(
  state: unknown,
): Map<string, { getNewEntity: (id: number) => unknown }> | undefined {
  return (state as { mutationViews?: Map<string, { getNewEntity: (id: number) => unknown }> }).mutationViews;
}

/**
 * The model slice, typed over the WHOLE store.
 *
 * There used to be a `ModelCrossSliceState` here: sixteen fields owned by
 * `dataSlice`, `selectionSlice`, `visibilitySlice`, `pinboardSlice` and
 * `addElementSlice`, declared on this slice purely so `removeModel` and
 * `clearAllModels` could type-check their reach into all five. Teardown no
 * longer reaches: it returns a patch composed by the owning slices
 * (`store/teardown-registry.ts`), so the interface is gone.
 *
 * What is left is real and is not teardown: `addModel`, `upsertModel`,
 * `updateModel` and `setActiveModel` keep `dataSlice`'s `ifcDataStore` /
 * `geometryResult` pointed at the ACTIVE model, in the same `set` that moves
 * the model map. `ViewerState` — the same generic `collabSlice` uses — is how
 * that is declared now: the store's own type, not a hand-listed shadow of five
 * other slices that could silently drift from them.
 */
export const createModelSlice: StateCreator<ViewerState, [], [], ModelSlice> = (set, get) => ({
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
    // a third, subtly different reading of a key format — the exact hazard
    // `slices/selectionSlice.teardown.ts` calls out and routes through
    // `stringToEntityRef` to avoid. Losing a highlight on an unrelated model's removal is cheap;
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

    // The IDS per-row focus (#2867) owns the same two shared channels clash
    // does — `focusEntity` installs the activated row's element into
    // `isolatedEntities` or `ghostExceptEntities` — and a row isolation left
    // standing over a federation that just changed is the same blank viewport
    // #2654 describes, with nothing on screen to explain it. Released by
    // IDS's OWN record, so a presentation belonging to clash, the spaces
    // X-ray or IDS's set-level isolate buttons survives untouched. The row
    // focus's colour marker goes with it — both channels it wrote.
    //
    // CORRECTION (review of #2867): an earlier revision of this comment
    // claimed this "must also precede the IDS clears below, which drop the
    // record". It does not. The only clear below is
    // `clearIdsValidationReport`, which releases through this same helper
    // BEFORE nulling the record — moving this call after it passes the whole
    // suite (verified). The order here is not load-bearing and is not
    // asserted; what IS load-bearing is the release-before-null order INSIDE
    // `clearIdsValidationReport` (idsSlice), where it is asserted.
    endIdsRowFocusPresentation(get() as unknown as IDSRowFocusPresentation);

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

    // Unregister from the federation registry. This used to sit INSIDE the
    // `set` updater below; it is a side effect on a singleton rather than
    // state, and nothing between here and the `set` reads it — the survivor
    // predicate is computed from `models`, not from the registry. Partial
    // removal BURNS the freed offset range instead of reclaiming it
    // (`federation-registry.ts`), which is why a teardown may purge THIS
    // model's global ids and leave every survivor's alone.
    federationRegistry.unregisterModel(modelId);

    // One composed patch, built by the slices that own the fields
    // (`store/teardown-registry.ts`) — including `dataSlice`'s scoped purge of
    // the mesh-colour backup, which used to be computed here.
    // `modelRemovedScope` carries the survivor-range predicate every
    // global-id-keyed slice filters on: the loop that used to live in this
    // function AND, verbatim, in `syncSourceModel`'s second purge.
    //
    // Read the state ONCE and hand the same object to both: the scope's
    // survivor set and the contributions that filter against it must not be
    // computed off two different snapshots.
    //
    // Applied through the slice's own `set`, which is the store's wrapped
    // setter, so the shared isolate / ghost channels this can null still go
    // through `withVisibilityOwnershipInvalidation`.
    const state = get();
    set(viewerTeardown(modelRemovedScope(state, modelId), state));
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
    // Same claim, released the same way: with every model gone the clash
    // helper above has already cleared both channels outright, so this
    // normally just drops the record — which it must, because a record that
    // outlives its presentation re-matches as soon as any other owner
    // installs equal content (#2654 fourth review).
    endIdsRowFocusPresentation(get() as unknown as IDSRowFocusPresentation);
    // Clear the federation registry
    federationRegistry.clear();
    // Same dangling reference as `removeModel`'s `addElementModelId` cleanup,
    // just for every model at once: with `models` about to become empty there
    // is no federated model left for the AddElement panel's pin to name, so it
    // and the model-local storey id go too. Same for every global-id set
    // `removeModel` purges by range (selection, hidden, isolated, ghost, class
    // filter, and the per-model maps): with zero survivors every id in them is
    // stale by definition, so the composed teardown at the end of this function
    // clears them unconditionally rather than repeating the range check for an
    // always-true answer. `isolatedEntities`/`ghostExceptEntities` clear to
    // `null` (not an empty `Set`) for the same reason `removeModel` does — an
    // empty-but-set isolate would hide the very next model loaded, until it
    // does. Each of those clears now lives with the slice that owns the field;
    // this note stays here because it is the reason the OVERLAY call below is
    // unconditional too.
    // `federationRegistry.clear()` above resets the offset counter to 0, so
    // the very next model registered can be handed the exact global ids a
    // still-registered overlay layer's `hiddenIds`/`colorOverrides` name.
    // `overlaySlice.overlayLayers` stores each layer's contribution as
    // already-translated GLOBAL ids — `useConstructionSequence.ts` converts
    // via `toGlobalIdFromModels` at REGISTRATION time, not at read time
    // (store/globalId.ts) — so a layer registered before this clear keeps
    // naming those exact numbers afterward. That hook's registration effect
    // deps (`[animationEnabled, playbackTime, scheduleData,
    // activeWorkScheduleId, animationSettings]`) exclude `models`, and
    // `scheduleData` is untouched by `clearAllModels`, so a PAUSED animation
    // (no `playbackTime` advance to re-trigger the effect) leaves the
    // 'animation' layer registered with its pre-clear ids indefinitely.
    // `useOverlayCompositor.ts` applies `computeCompositeOverlay()`'s output
    // straight to `hideEntities`/`setPendingColorUpdates` by global id with
    // no re-resolution, so a recycled offset lands the stale hide/colour on
    // whatever live entity the reloaded federation assigns that number to —
    // same offset-reuse-misresolution shape as `compareResult` / the lens
    // (#2854). Unconditional, like those: with every model gone there is no
    // federation left for any layer to describe correctly either way.
    //
    // `removeModel` deliberately does NOT get the equivalent guarded call:
    // `unregisterModel` BURNS the freed offset range instead of reclaiming
    // it (`federation-registry.ts`), so a layer left registered after a
    // partial removal cannot ever be handed to a new model — it dangles
    // harmlessly, same as the `compareResult` non-participant case in
    // `removeModel-compare-stale.test.ts`, and the same reasoning
    // `clearAllModels-overlay-stale.test.ts`'s negative control proves.
    (get() as unknown as { clearOverlayLayers?: () => void }).clearOverlayLayers?.();
    // Same offset-reuse hazard as the overlay layer above, on the compare
    // channel: the very next model registered can be handed the exact
    // offsets any surviving compare result's `excludedHiddenIds` / `diff` global ids
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
    // One composed patch, built by the slices that own the fields
    // (`store/teardown-registry.ts`). Every 'all-models-cleared' arm clears
    // unconditionally rather than range-checking: `federationRegistry.clear()`
    // above restarts the offset counter at 0, so with zero survivors every
    // stored global id is stale by definition AND the very next model loaded
    // can be handed those exact numbers back.
    set(viewerTeardown({ kind: 'all-models-cleared' }, get()));
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
