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
 * three take the same expansion here. (Expansion is the whole fix for hide and
 * isolate; colour also needs a repaint once a late part's mesh arrives, which
 * this module does not own — see #3890.) That is why this module is named for
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
 * geometry-less id to ALL of its aggregated parts, whether or not they render
 * right now (#3426, then #3865, which dropped the "only the meshed ones unless
 * none of them are" split so a part that streams in later is already in the
 * persisted set). This module just receives a non-empty `resolved` for that
 * case and unions it in as it does for any ordinary element.
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
 * resolver answers with ALL of a geometry-less id's aggregated parts, so a
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

/**
 * The same policy for the COLOUR channel, whose input is an id→colour map
 * rather than a flat id list (`viewer-adapter.ts`'s `colorize`/`colorizeAll`,
 * and the embed bridge's `SET_COLORS`).
 *
 * A colour map cannot just be flattened through `resolvePresentationIds`: each
 * id carries its own colour, and the expansion has to keep the pairing.
 *
 * ## The rule, in full
 *
 * 1. An id the caller named EXPLICITLY always wins, whatever colour it would
 *    have inherited as some assembly's part. Colouring an assembly red and one
 *    of its own parts blue leaves that part blue.
 * 2. Between two INHERITED claims on the same id — two assemblies that share a
 *    part, coloured differently — the LAST entry wins, matching the plain
 *    last-wins the callers already had for explicit ids (`colorizeAll` builds
 *    its map with `set`, and `Object.entries` on a `SET_COLORS` colourMap keeps
 *    insertion order).
 *
 * ## Why there are two paths through this
 *
 * The resolver is a batch call, so resolving each entry on its own would cost
 * one call per id. That is not free: `Viewport.tsx`'s `resolveRenderableIds`
 * allocates a fresh bounds cache per call (its `boundsOf` default argument),
 * reads the store, and can warn — a whole-model `colorizeAll` would pay all of
 * that thousands of times. So ids are GROUPED by colour and each group is
 * resolved in one call.
 *
 * Grouping loses the entry position of an inherited id, which is exactly what
 * rule 2 needs. It only matters when two groups actually claim the same
 * expanded id: with no overlap, every order produces the identical map, so the
 * cheap path is not a weaker rule, it is the same rule computed cheaply. When
 * an overlap IS present the per-group expansions genuinely cannot say which
 * entry produced the contested id, and this falls back to resolving entry by
 * entry, in order. That path costs one resolver call per entry, and is reached
 * only when a caller colours two overlapping assemblies differently in one
 * call.
 */
export function resolvePresentationColorMap<C extends readonly number[]>(
  resolver: ((ids: number[]) => number[]) | undefined,
  entries: Iterable<readonly [number, C]>,
): Map<number, C> {
  const raw = [...entries];
  const byColor = new Map<string, { color: C; ids: number[] }>();
  for (const [id, color] of raw) {
    const key = String(color);
    const group = byColor.get(key);
    if (group) group.ids.push(id);
    else byColor.set(key, { color, ids: [id] });
  }
  const groups = [...byColor.values()].map((group) => ({
    color: group.color,
    expanded: resolvePresentationIds(resolver, group.ids),
  }));

  const claimed = new Set<number>();
  let contested = false;
  for (const group of groups) {
    for (const id of group.expanded) {
      if (claimed.has(id)) contested = true;
      claimed.add(id);
    }
  }

  const out = new Map<number, C>();
  if (contested) {
    for (const [id, color] of raw) {
      for (const expandedId of resolvePresentationIds(resolver, [id])) out.set(expandedId, color);
    }
  } else {
    for (const group of groups) {
      for (const id of group.expanded) out.set(id, group.color);
    }
  }
  for (const [id, color] of raw) out.set(id, color);
  return out;
}
