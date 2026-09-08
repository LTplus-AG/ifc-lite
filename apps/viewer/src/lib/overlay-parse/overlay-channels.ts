/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which IFC classes the symbolic 2D overlay draws, per channel — the ONE
 * definition of it.
 *
 * The same two names used to be spelled out at four points of the same
 * pipeline: the flatten filter (`symbolic-flat.ts`), the bucket routing
 * (`symbolic-parse.ts`), the parse-cache short-circuit
 * (`hooks/symbolic-parse-cache.ts`) and, in the first attempt at #2934, a
 * fresh copy in the visibility gate that got one of them wrong — it asked
 * whether `'IfcGrid'` was hidden, a class the overlay never draws, so a host
 * naming `IfcGridAxis` (the class actually in their data) would have got
 * exactly the silence the fix existed to end. `store/typeVisibilityFilter.ts`
 * pulled the same kind of scattered table back into one place for the mesh
 * side.
 *
 * Anything routed here comes from Rust, which stamps each symbolic
 * representation with its OWNING entity's class (`rust/processing/src/
 * symbolic/mod.rs`: `entity.ifc_type.name()`), not with the representation
 * identifier. So `Plan | Annotation | FootPrint | Axis` reps of ordinary
 * products — a wall's `Axis`, a space's `FootPrint` — arrive as
 * `IfcWallStandardCase` / `IfcSpace` and are dropped by the `'overlay'`
 * filter below. The overlay's two channels therefore carry ONE owner class
 * each, which is what lets a channel-level gate mean exactly "this class is
 * hidden" (see `lib/symbolic-overlay-gate.ts`).
 */

/**
 * Owner classes per overlay channel. The channel keys are the renderer's line
 * channels (`SymbolicLineChannels`), which the grid got its own of in #862 so
 * grids can be hidden without losing dimensions and leaders.
 */
export const OVERLAY_CHANNEL_OWNER_TYPES = {
  annotation: ['IfcAnnotation'],
  grid: ['IfcGridAxis'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** A symbolic overlay line channel. */
export type OverlayChannel = keyof typeof OVERLAY_CHANNEL_OWNER_TYPES;

const GRID_CHANNEL_OWNER_TYPES: ReadonlySet<string> = new Set(OVERLAY_CHANNEL_OWNER_TYPES.grid);

/**
 * Every owner class the overlay draws, flat, for callers that need the names
 * rather than a predicate. The parse-cache short-circuit is one: it asks the
 * entity store whether the model contains any of them before paying for a
 * full-source WASM scan, so it needs the list, not a test.
 */
export const OVERLAY_OWNER_TYPE_NAMES: readonly string[] =
  Object.values(OVERLAY_CHANNEL_OWNER_TYPES).flat();

const OVERLAY_OWNER_TYPES: ReadonlySet<string> = new Set(OVERLAY_OWNER_TYPE_NAMES);

/** The owner types the annotation overlay renders at all (issue #862). */
export function isOverlayOwnerType(ifcType: string): boolean {
  return OVERLAY_OWNER_TYPES.has(ifcType);
}

/** True for the owner types that bucket into the GRID channel rather than the
 *  annotation one — the split `symbolic-parse.ts` routes on. */
export function isGridChannelOwnerType(ifcType: string): boolean {
  return GRID_CHANNEL_OWNER_TYPES.has(ifcType);
}
