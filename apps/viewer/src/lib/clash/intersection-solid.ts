/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand wrapper around the wasm `clashIntersectionSolid` binding — the
 * true overlap VOLUME of one clashing pair (base branch `feat/clash-
 * intersection-solid`).
 *
 * Deliberately per-pair, called only when a clash row is selected: measured on
 * the bridge model, 88 pairs computed eagerly cost 216 ms and only 30 of them
 * resolve to a solid at all (the other 58 are genuine grazing contacts below
 * the kernel's ~15.26 µm snap resolution). One pair on demand costs a median
 * 0.59 ms, worst case 38.6 ms — the eager sum, paid once per selection instead
 * of once per model load.
 */

import init, { clashIntersectionSolid } from '@ifc-lite/wasm';

/**
 * Why the kernel could not resolve a solid — the full set of `degenerateReason`
 * strings `clashIntersectionSolid` can return, pinned against the Rust source by
 * `scripts/check-clash-degenerate-reason-parity.mjs`. (`intersection-solid.test.ts`
 * exercises the kernel's BEHAVIOUR; a declaration-parity claim needs both
 * SOURCES, which is banned in test files, so it lives as a lint.)
 *
 * That is a wider set than the geometry crate's `DegenerateReason` enum:
 * `'malformed-operand'` is the wasm BINDING's own verdict, produced by
 * `mesh_from` in `clash_solid.rs` before the boolean ever runs, and has no enum
 * variant behind it. The reason crosses the wasm boundary as an untyped string
 * and is cast on arrival, so TypeScript cannot catch a member missing here.
 */
export type ClashSolidDegenerateReason =
  /**
   * The binding rejected an operand rather than computing on it: a positions or
   * indices length that is not a multiple of 3, an index past its own operand's
   * vertex count, or a non-finite (NaN/infinity) coordinate.
   */
  | 'malformed-operand'
  | 'empty-operand'
  | 'no-overlap'
  | 'below-kernel-resolution'
  | 'budget-exhausted';

export type ClashIntersectionSolidResult =
  | {
      isSolid: true;
      /** World-space vertex positions, flat `[x, y, z, …]`, f64. */
      positions: Float64Array;
      /** Triangle indices into `positions / 3`. */
      indices: Uint32Array;
      volumeM3: number;
    }
  | {
      isSolid: false;
      reason: ClashSolidDegenerateReason;
      /** For `below-kernel-resolution`: measured thinnest extent, metres. `0` otherwise. */
      thicknessM: number;
      /** For `below-kernel-resolution`: the depth the kernel would have needed, metres. `0` otherwise. */
      requiredM: number;
    };

let wasmReady: Promise<void> | null = null;
/** Initialise the wasm module once (idempotent — safe to call from every site that needs it). */
function ensureWasm(): Promise<void> {
  if (!wasmReady) wasmReady = init().then(() => undefined);
  return wasmReady;
}

/**
 * Compute the intersection solid of one clashing pair. Both operand meshes
 * must already be in the common WORLD FRAME (the same convention
 * `contactClusters` uses in `useClash.ts` — any per-model federation
 * transform must already be baked into `positions`).
 *
 * Frees the wasm-owned buffer before returning; the result is a plain JS
 * object, never a live wasm handle.
 */
export async function computeClashIntersectionSolid(
  positionsA: Float32Array,
  indicesA: Uint32Array,
  positionsB: Float32Array,
  indicesB: Uint32Array,
): Promise<ClashIntersectionSolidResult> {
  await ensureWasm();
  const solid = clashIntersectionSolid(positionsA, indicesA, positionsB, indicesB);
  try {
    if (solid.isSolid) {
      return {
        isSolid: true,
        positions: solid.positions,
        indices: solid.indices,
        volumeM3: solid.volumeM3,
      };
    }
    return {
      isSolid: false,
      reason: solid.degenerateReason as ClashSolidDegenerateReason,
      thicknessM: solid.thicknessM,
      requiredM: solid.requiredM,
    };
  } finally {
    solid.free();
  }
}
