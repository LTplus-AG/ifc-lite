/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Struct-of-arrays flattening of the WASM extruded-solid profile collection.
 *
 * The profile sibling of `symbolic-flat.ts`, and the same contract: the WASM
 * handles this walks cannot cross a `postMessage` boundary, so the worker
 * flattens them into transferable typed arrays here and the main thread
 * reassembles the `ProfileEntry[]` from those arrays (`buildProfileEntries` in
 * `profile-entries.ts`).
 *
 * Verbatim: every field the main-side walk read off a `ProfileEntryJs` is
 * carried across unchanged, in the element type WASM produced it in — `f32`
 * coordinates into `Float32Array`, `u32` express ids and hole counts into
 * `Uint32Array` (never a `Float32Array`; express ids exceed 2^24 on large
 * models). Nothing is rounded, reordered, or filtered on this side, and no
 * profile is dropped: the projector's own guards stay where they are.
 *
 * The RTC/`originShift` correction is deliberately NOT applied here. It reads
 * `geometryResult.coordinateInfo`, which is main-thread state, so it stays with
 * the rebuild (see `profile-entries.ts`).
 */

import type { ProfileCollection } from '@ifc-lite/wasm';

/**
 * A whole profile collection as transferable arrays.
 *
 * Variable-length data (outer ring vertices, hole counts, hole vertices) is
 * concatenated into one buffer per kind with a companion `*Start` offset array
 * of length `N + 1`: entry `i` spans `[start[i], start[i + 1])`. Offsets are
 * **element** indices into the array they describe, so a ring with an odd float
 * count survives verbatim rather than being reconstructed from a vertex count.
 * Fixed-width data uses a fixed stride, which the Rust types guarantee
 * (`transform: [f32; 16]`, `extrusion_dir: [f32; 3]`).
 *
 * Every array is backed by its own `ArrayBuffer`, so the whole struct can be
 * handed to `postMessage` as a transfer list.
 */
export interface FlatProfiles {
  /**
   * IFC type names, deduplicated. {@link FlatProfiles.typeIndex} indexes into
   * this. The table is unbounded — a profile is extracted for every product
   * with an extruded-area-solid body, not a filtered subset — which is why the
   * index array is 16-bit. An 8-bit index would wrap silently past 256 distinct
   * types and hand an entry somebody else's `ifcType`.
   */
  typeNames: string[];
  /** Index into {@link FlatProfiles.typeNames}, one per entry. */
  typeIndex: Uint16Array;
  /** Express id of the owning element, one per entry. */
  expressId: Uint32Array;

  /** Flat `[x, y, x, y, …]` outer rings for every entry, back to back. */
  outerPoints: Float32Array;
  /** `N + 1` **float**-index offsets into {@link FlatProfiles.outerPoints}. */
  outerStart: Uint32Array;

  /** Per-hole vertex counts for every entry, back to back. */
  holeCounts: Uint32Array;
  /** `N + 1` offsets into {@link FlatProfiles.holeCounts}. */
  holeCountStart: Uint32Array;

  /** Flat `[x, y, x, y, …]` hole rings for every entry, back to back. */
  holePoints: Float32Array;
  /** `N + 1` **float**-index offsets into {@link FlatProfiles.holePoints}. */
  holePointStart: Uint32Array;

  /** Stride 16: the column-major 4×4 world transform, per entry. */
  transform: Float32Array;
  /** Stride 3: `[dx, dy, dz]` extrusion direction, per entry. */
  extrusionDir: Float32Array;
  /** Extrusion depth in metres, one per entry. */
  extrusionDepth: Float32Array;
}

/** Floats per entry in {@link FlatProfiles.transform}. */
export const TRANSFORM_STRIDE = 16;
/** Floats per entry in {@link FlatProfiles.extrusionDir}. */
export const EXTRUSION_DIR_STRIDE = 3;

/** An empty flatten — the shape a skipped or failed parse produces. */
export function createEmptyFlatProfiles(): FlatProfiles {
  return {
    typeNames: [],
    typeIndex: new Uint16Array(0),
    expressId: new Uint32Array(0),
    outerPoints: new Float32Array(0),
    outerStart: new Uint32Array(1),
    holeCounts: new Uint32Array(0),
    holeCountStart: new Uint32Array(1),
    holePoints: new Float32Array(0),
    holePointStart: new Uint32Array(1),
    transform: new Float32Array(0),
    extrusionDir: new Float32Array(0),
    extrusionDepth: new Float32Array(0),
  };
}

/** Intern an IFC type name into the shared table, returning its index. */
function intern(names: string[], index: Map<string, number>, name: string): number {
  const existing = index.get(name);
  if (existing !== undefined) return existing;
  const next = names.length;
  names.push(name);
  index.set(name, next);
  return next;
}

/**
 * Copy `count` floats out of a WASM-backed view, zero-filling any shortfall.
 *
 * The Rust getters return fixed-size arrays, so the shortfall branch is
 * unreachable today; it exists so an older wasm bundle cannot make the stride
 * arithmetic read into the NEXT entry's slot.
 */
function pushFixed(out: number[], values: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) out.push(i < values.length ? values[i] : 0);
}

/**
 * Flatten a WASM profile collection into transferable arrays.
 *
 * Frees every per-entry handle (`collection.get(i)`) in `try/finally`, exactly
 * as the main-thread walk did, so a mid-flatten throw cannot leak WASM memory
 * into the FinalizationRegistry (AGENTS.md §Geometry & WASM). Ownership of
 * `collection` itself stays with the caller.
 */
export function collectFlatProfiles(collection: ProfileCollection): FlatProfiles {
  const typeNames: string[] = [];
  const typeTable = new Map<string, number>();

  const typeIndex: number[] = [];
  const expressId: number[] = [];
  const outerPoints: number[] = [];
  const outerStart: number[] = [0];
  const holeCounts: number[] = [];
  const holeCountStart: number[] = [0];
  const holePoints: number[] = [];
  const holePointStart: number[] = [0];
  const transform: number[] = [];
  const extrusionDir: number[] = [];
  const extrusionDepth: number[] = [];

  const len = collection.length;
  for (let i = 0; i < len; i++) {
    const entry = collection.get(i);
    if (!entry) continue;
    try {
      typeIndex.push(intern(typeNames, typeTable, entry.ifcType));
      expressId.push(entry.expressId);

      const outer = entry.outerPoints;
      for (let j = 0; j < outer.length; j++) outerPoints.push(outer[j]);
      outerStart.push(outerPoints.length);

      const counts = entry.holeCounts;
      for (let j = 0; j < counts.length; j++) holeCounts.push(counts[j]);
      holeCountStart.push(holeCounts.length);

      const holes = entry.holePoints;
      for (let j = 0; j < holes.length; j++) holePoints.push(holes[j]);
      holePointStart.push(holePoints.length);

      pushFixed(transform, entry.transform, TRANSFORM_STRIDE);
      pushFixed(extrusionDir, entry.extrusionDir, EXTRUSION_DIR_STRIDE);
      extrusionDepth.push(entry.extrusionDepth);
    } finally {
      entry.free();
    }
  }

  return {
    typeNames,
    typeIndex: Uint16Array.from(typeIndex),
    expressId: Uint32Array.from(expressId),
    outerPoints: Float32Array.from(outerPoints),
    outerStart: Uint32Array.from(outerStart),
    holeCounts: Uint32Array.from(holeCounts),
    holeCountStart: Uint32Array.from(holeCountStart),
    holePoints: Float32Array.from(holePoints),
    holePointStart: Uint32Array.from(holePointStart),
    transform: Float32Array.from(transform),
    extrusionDir: Float32Array.from(extrusionDir),
    extrusionDepth: Float32Array.from(extrusionDepth),
  };
}
