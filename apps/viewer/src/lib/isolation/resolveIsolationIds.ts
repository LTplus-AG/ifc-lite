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
 *   - they are genuinely geometry-less with no renderable aggregated part.
 *
 * Only the third deserves "do nothing". Treating all three that way makes an
 * IDS/lens/SDK/embed isolate of a hidden-type set a silent no-op, which is why
 * `PropertiesPanel.tsx`'s zone isolate (#1075) and `SearchModal.filter.tsx`'s
 * "Isolate in 3D" (#2660) both keep the raw ids on an empty resolve — the
 * hidden-type case is the case they exist for. Carrying an id that owns no
 * mesh is free: `isolatedEntities` is a whitelist the renderer matches mesh
 * ids against, so an id with no mesh simply never matches, and the isolation
 * starts showing the right thing as soon as the toggle flips or the batch
 * lands.
 *
 * The residual gap, stated rather than papered over: for the third situation
 * this still isolates a set with no mesh in it and the viewport goes blank
 * (#3426). Closing that needs a resolver that can see UNFILTERED geometry and
 * so can say "geometry is in and nothing here renders" as a fact distinct from
 * `[]`; that is Viewport/ViewportContainer plumbing, not a policy this
 * function can infer. What is fixed here is #3338: an assembly whose parts DO
 * render now contributes those parts in every channel that routes through here.
 */
export function resolveIsolationIds(
  resolver: ((ids: number[]) => number[]) | undefined,
  rawIds: readonly number[],
): number[] {
  const resolved = resolver?.([...rawIds]) ?? [];
  return [...new Set([...resolved, ...rawIds])];
}
