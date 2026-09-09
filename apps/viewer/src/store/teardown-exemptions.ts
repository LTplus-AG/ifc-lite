/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The slices that deliberately have NO entry in `teardown-registry.ts`, and why.
 *
 * `teardown-registry.test.ts`'s "every slice is either registered or exempt"
 * guard reads this map. A slice composed into `ViewerState` (see `index.ts`)
 * must have EITHER a registered `SliceTeardown` export OR an entry here —
 * anything else fails that test by name. That is the whole point: issue
 * #4249 found `splitToolSlice` with neither, silently, for as long as nobody
 * happened to grep for it. This file is where "silently" stops being possible.
 *
 * Keyed by slice file basename (no extension), matching the `slice` field
 * `defineSliceTeardown` records, e.g. `'measurementSlice'`.
 *
 * Adding an entry here is a claim, not a formality: it says the slice holds
 * no per-model / per-federation state, OR it tears itself down through some
 * OTHER mechanism this comment can point to. Both are checked by hand at
 * review time; the guard only checks that the claim was WRITTEN DOWN.
 */
export const TEARDOWN_EXEMPTIONS: Readonly<Record<string, string>> = {
  measurementSlice:
    "Torn down by an explicit action call, not the pure teardown seam: `resetViewerState` " +
    '(store/index.ts) calls `get().resetAllMeasurementState()`, which owns its own full field ' +
    'list (see that action\'s doc comment for why the list must not be duplicated as a ' +
    "`SliceTeardown`). An action is a side effect a pure teardown may not perform — see " +
    'teardown-registry.ts\'s own module doc, "Slices that are absent".',

  clashSlice:
    'Torn down by a shared helper, not the pure teardown seam: `endClashScenePresentation` ' +
    '(lib/clash/visibility-ownership.ts) runs at all three model-lifecycle entry points ' +
    "(store/index.ts's `resetViewerState` and `clearAllModels`, and `modelSlice.ts`'s " +
    '`removeModel`) and clears the clash result, focus presentation and owned visibility ' +
    'channels together, in an order that matters (release before null, documented on ' +
    'teardown.ts). A pure per-scope `SliceTeardown` cannot express that ordering.',

  sourcesSlice:
    '`sourceTags` (Map<modelId, SourceTag>) is kept in sync by direct cross-slice calls at ' +
    'the two entry points that can invalidate it: `modelSlice.ts` `removeModel` calls ' +
    '`removeSourceTag(modelId)` and `clearAllModels` calls `clearSourceTags()`. Both go ' +
    'through the slice\'s own actions rather than a `SliceTeardown` contribution, so a tag ' +
    'can never outlive its model.',

  extensionsSlice:
    'Every field is either a panel-visibility flag or session-scoped UI handoff state ' +
    '(pending authored bundle, requested tab, one-shot dialog flags) — none of it references ' +
    'a modelId, an expressId, or model-derived geometry, so nothing goes stale when a model ' +
    'is removed or the federation is cleared.',

  dockSlice:
    'Floating-panel layout (which panels float, their geometry, their snap zone) is a ' +
    'cross-file workspace preference persisted to localStorage — deliberately NOT cleared ' +
    'on a new file load (see the slice\'s module doc). It names no modelId or expressId.',

  sidebarSlice:
    'Sidebar layout (mode, width, panel order, hidden set) is a cross-file workspace ' +
    'preference persisted to localStorage, mirroring dockSlice — deliberately outlives a ' +
    'file load. It names no modelId or expressId.',

  solarSlice:
    'Solar-study intent (studied instant, display toggles) and the resolved sun readout are ' +
    'continuously recomputed from the live active model\'s georeference while the study is ' +
    'enabled (see useSolarEnvironment / useCesiumSolar) — the same "recompute every frame, ' +
    "don't cache across a model swap\" pattern as the environment/lighting slice. Nothing " +
    'here accumulates per-model state that removal could leave stale.',

  environmentSlice:
    'Lighting preset, exposure, shadow settings and the manual sun-time arc are all global ' +
    'rendering preferences persisted to localStorage, independent of which model (if any) is ' +
    'loaded. It names no modelId or expressId.',

  overlaySlice:
    '`overlayLayers` colour/hidden contributions are keyed by GLOBAL id ' +
    '(`toGlobalIdFromModels` applied at registration time — see the slice\'s module doc), and ' +
    'each model keeps a fixed `idOffset` for its lifetime, so a removed model\'s ids never ' +
    'collide with a survivor\'s. `clearOverlayLayers()` is called directly by ' +
    '`modelSlice.clearAllModels`, covering the one scope (all models gone) where every layer ' +
    'is guaranteed stale.',

  collabSlice:
    '`collabRoomModelId` is a documented, deliberate KNOWN GAP (see the field\'s own doc ' +
    'comment): it goes stale if the room\'s model is removed mid-session, and the comment ' +
    'explains at length why clearing it on removal would be WORSE (the room would silently ' +
    'retarget to `activeModelId` instead of failing closed). This is a recorded product ' +
    'decision, not an oversight — do not add a teardown for this field without revisiting ' +
    'that decision first.',

  levelDisplaySlice:
    '`appliedStoreyOffsets` (Map<modelId, Map<storeyExpressId, offset>>) is fully ' +
    "recomputed and overwritten every time `useLevelDisplayEffect` runs, and that effect's " +
    'dependency array includes the store\'s `models` map, so it re-runs on every model add ' +
    'or remove and rebuilds the map from the CURRENT model set — a removed model\'s entry is ' +
    'dropped by the next render, not left to a teardown.',

  unitDisplaySlice:
    'Display-unit overrides are keyed by unit-TYPE token (e.g. "LENGTHUNIT"), not by model ' +
    'or expressId, and persist to localStorage workspace-wide. It names no modelId or ' +
    'expressId.',

  spaceMouseSlice:
    'WebHID device connection state and sensitivity — no field references a modelId or ' +
    'expressId.',

  layerStackSlice:
    'The IFCX layer composition (layerStack / layerStackPathToId / layerStackDiff) is only ' +
    'ever populated by a full federated (re-)load, which always calls `setLayerStack(...)` ' +
    'right after `clearAllModels()` in the same synchronous flow, and a non-federated load ' +
    'calls `clearLayerStack()` explicitly (`useIfcLoader.ts`). KNOWN GAP, not covered by this ' +
    'exemption\'s reasoning: `useFileCommands.tsx`\'s multi-file, non-all-IFCX branch calls ' +
    '`clearAllModels()` then `loadFilesSequentially()` without ever touching layerStack, so a ' +
    'PRIOR IFCX composition\'s entries can survive into a session that loaded plain IFC files ' +
    '— `LayersPanel.tsx` renders `layerStack` with no membership guard. Left for a follow-up ' +
    '(same shape as the splitToolSlice fix this branch makes, but in call-site wiring, not ' +
    'the teardown seam) rather than fixed here to keep this PR scoped to the registration gap.',

  appearanceSlice:
    'Verified 2026-09-09 field by field against `AppearanceDraftRecipe` (lib/appearance/draft-' +
    'types.ts): `sourceId`, `settings` and `previewEnabled` name no modelId or expressId; only ' +
    '`appearanceDraft.modelId` is per-model, and it has exactly ONE read site across the repo. ' +
    'That site self-heals: `useAppearancePanel.ts` computes `canResumeModel` (`!savedDraft' +
    "?.modelId || models.has(savedDraft.modelId)`) once at mount to decide whether to resume " +
    'the saved model at all, and every subsequent render re-derives the `modelId` actually used ' +
    "(`chosenModel && models.has(chosenModel) ? chosenModel : activeModelId`) — the same " +
    "`models.has` guard runs on every render, not just mount, so a model removed while the " +
    'panel is open falls back to `activeModelId` immediately rather than reading through a ' +
    "stale id. `scope`'s `typeId` (also per-model, an express id) is React `useState`, not " +
    "store state, and is only ever SEEDED from `savedDraft.scope` when `canResumeModel` is " +
    'true, i.e. the same model — it cannot carry a stale id from a different model into this ' +
    'field either. `appearanceSources` is a session-wide source catalog (thumbnails, no ' +
    'modelId field) shared across models — every entry is added by `upload()` from a user ' +
    'file, never from a loaded model\'s embedded resources, so it cannot pick up per-model ' +
    'data by another route. Neither field is written to localStorage, a collab message, or ' +
    'an export payload (no `persist`/`partialize` wraps this store; grepped `lib/collab` and ' +
    "`lib/export` for both field names — no hits). The image BYTES this feature retains " +
    '(archive-embedded and uploaded originals, decoded bitmaps) live in the separate ' +
    '`modelAppearanceAssets` / `appearanceAssets` registries (lib/appearance/model-assets.ts), ' +
    "not in this slice's Zustand state, and that registry already has its own explicit " +
    "teardown at both model-lifecycle sites (`modelSlice.ts`'s `removeModel` calls " +
    '`modelAppearanceAssets.remove(modelId)`, `clearAllModels` calls ' +
    '`modelAppearanceAssets.clear()`) — outside the scope of this guard, but confirmed so the ' +
    'exemption above is not silently relying on it.',
};
