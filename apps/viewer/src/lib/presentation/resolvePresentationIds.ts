/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place that says which ids a PRESENTATION channel installs into the
 * renderer, given the raw ids a user (or a host script) picked and whatever
 * `cameraCallbacks.resolveHighlightIds` answers for them.
 *
 * A presentation channel is any channel whose ids end up matched against MESH
 * ids: isolate (`isolatedEntities`), hide/show (`hiddenEntities`), and colour
 * (`updateMeshColors` / `pendingColorUpdates`). All three share one failure
 * mode — a geometry-less `IfcElementAssembly` id owns no mesh, so isolating it
 * blanks the viewport and hiding or colouring it does nothing at all — and all
 * three are fixed by the same expansion. That is why this module is named for
 * the class of channel rather than for isolation: a `hide` handler written
 * against a module called "isolation ids" learns nothing, which is exactly the
 * "one call site every channel has to remember" shape #3338 is about.
 *
 * The policy is #3382's, unchanged: the resolved ids are UNIONED with the raw
 * ids, never substituted for them (#2680). What this module adds is a single
 * named home for it, so `scripts/check-isolate-expansion-routing.mjs` can
 * require every isolation channel to route through the same call.
 *
 * Why union rather than replace, and why an empty resolve still installs the
 * raw ids: `resolveHighlightIds` bounds-checks against the type-visibility
 * FILTERED mesh list (`ViewportContainer.tsx`'s `filteredGeometry`), and
 * `TYPE_VISIBILITY_SEMANTIC_DEFAULTS` ships `spaces`, `spatialZones`,
 * `openings` and `virtualElements` OFF (`store/constants.ts`). So `[]` is what
 * the resolver answers for FOUR different situations that it cannot tell
 * apart from the outside:
 *
 *   - the ids are hidden by a type toggle right now (an `IfcSpace` at the
 *     shipped default), and render the moment the user flips it on;
 *   - their meshes have not streamed in yet (`filteredGeometry` is non-null
 *     from the FIRST batch and grows incrementally, so a mesh that has not
 *     arrived reads exactly like one that does not exist);
 *   - they are geometry-less but have `IfcRelAggregates` parts that will
 *     render (an `IfcElementAssembly` and the like);
 *   - they are genuinely geometry-less with no aggregated part at all.
 *
 * Only the last deserves "do nothing". Treating all four that way makes an
 * IDS/lens/SDK/embed isolate of a hidden-type set a silent no-op, which is why
 * `PropertiesPanel.tsx`'s zone isolate (#1075) and `SearchModal.filter.tsx`'s
 * "Isolate in 3D" (#2660) both keep the raw ids on an empty resolve — the
 * hidden-type case is the case they exist for. Carrying an id that owns no
 * mesh is free: `isolatedEntities` is a whitelist the renderer matches mesh
 * ids against, so an id with no mesh simply never matches, and the isolation
 * starts showing the right thing as soon as the toggle flips or the batch
 * lands.
 *
 * The third situation is handled one level down, in
 * `expandToGeometryBearingIds` (`utils/aggregation.ts`), which
 * `resolveHighlightIds` (`Viewport.tsx`) is built on: it expands a
 * geometry-less id to its aggregated parts, falling back to ALL of them when
 * none of them currently render (#3426). This module just receives a
 * non-empty `resolved` for that case and unions it in as it does for any
 * ordinary element.
 *
 * The fourth has nothing to expand to, so it stays a blank isolate: this
 * module unions in the bare raw id and no mesh ever matches it. That case is
 * invisible from here — this function only ever sees ids, never the model
 * graph — so the signal for it lives in `resolveRenderableIds`
 * (`Viewport.tsx`), which warns once streaming has finished.
 */
export function resolvePresentationIds(
  resolver: ((ids: number[]) => number[]) | undefined,
  rawIds: readonly number[],
): number[] {
  const resolved = resolver?.([...rawIds]) ?? [];
  return [...new Set([...resolved, ...rawIds])];
}

/**
 * Whether an isolate/highlight request resolved to a set with nothing that can
 * render right now. This is the condition `resolveRenderableIds`
 * (`Viewport.tsx`) warns on once geometry streaming has finished, i.e. the
 * fourth situation above plus its post-#3426 sibling.
 *
 * `resolved.length === 0` is NOT that condition any more. Since #3426 the
 * resolver falls back to ALL of a geometry-less id's aggregated parts, so a
 * NON-empty `resolved` can still be entirely mesh-less — an assembly whose
 * parts never render is exactly the blank viewport the warning exists to
 * surface, and counting the result would step straight past it. Renderability
 * has to be asked per resolved id instead.
 *
 * An empty request is not a defect, so it never warns. The caller owns the
 * streaming gate: mid-stream, "nothing renders yet" is the expected state.
 */
export function hasNoRenderableTarget(
  requested: readonly number[],
  resolved: readonly number[],
  hasGeometry: (id: number) => boolean,
): boolean {
  if (requested.length === 0) return false;
  return !resolved.some(hasGeometry);
}
