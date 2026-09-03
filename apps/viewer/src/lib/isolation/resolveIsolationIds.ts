/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place that says what an isolate call site installs into the
 * isolation channel, given the raw ids it was asked to isolate and whatever
 * `cameraCallbacks.resolveHighlightIds` answers for them.
 *
 * The policy is #3382's, unchanged: the resolved ids are UNIONED with the raw
 * ids, never substituted for them (#2680). What this module adds is a single
 * named home for it, so `scripts/check-isolate-expansion-routing.mjs` can
 * require every isolation channel to route through the same call — the "one
 * call site every channel has to remember" shape #3338 is about.
 *
 * Why union rather than replace, and why an empty resolve still installs the
 * raw ids: `resolveHighlightIds` bounds-checks against the type-visibility
 * FILTERED mesh list (`ViewportContainer.tsx`'s `filteredGeometry`), and
 * `TYPE_VISIBILITY_SEMANTIC_DEFAULTS` ships `spaces`, `spatialZones`,
 * `openings` and `virtualElements` OFF (`store/constants.ts`). So `[]` is what
 * the resolver answers for THREE different situations that it cannot tell
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
 * #3426, correcting #3382: the third situation used to fall all the way back
 * to the raw ids too, which converts one empty viewport (isolating `[]`) into
 * a DIFFERENT empty viewport (isolating a geometry-less id with no mesh) —
 * the assembly's own id never matches anything, streamed or not. Closed in
 * `expandToGeometryBearingIds` (`utils/aggregation.ts`), which
 * `resolveHighlightIds` (`Viewport.tsx`) is built on: when none of an
 * assembly's aggregated parts currently render, it now falls back to ALL of
 * them (not just the currently-meshed ones) instead of dropping the id — so
 * this module receives a non-empty `resolved` for that case and unions it in
 * exactly as it already does for an ordinary element.
 *
 * The residual gap, stated rather than papered over: the fourth situation — no
 * geometry AND no aggregated descendant at all — has nothing to expand to;
 * this still unions in the bare raw id and the viewport goes blank, with no
 * distinguishing signal available at this layer (this function only ever sees
 * ids, not the model graph). `resolveRenderableIds` in `Viewport.tsx` is where
 * that distinction IS visible (it already resolved-and-found-nothing), so it
 * is what surfaces a console warning once streaming has finished — see the
 * comment there. What is fixed here is #3338 (assembly parts contributed
 * through every channel) and, now, the third row of #3426 (geometry-less WITH
 * parts). The fourth row (geometry-less, no parts) is the one case a resolver
 * genuinely cannot help with, because there is nothing to resolve to.
 */
export function resolveIsolationIds(
  resolver: ((ids: number[]) => number[]) | undefined,
  rawIds: readonly number[],
): number[] {
  const resolved = resolver?.([...rawIds]) ?? [];
  return [...new Set([...resolved, ...rawIds])];
}
