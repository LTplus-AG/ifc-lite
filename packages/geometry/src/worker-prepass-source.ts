/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TODO(remove-by: all supported deployed WASM assets include source-backed prepass APIs, louistrue)
// Track compatibility retirement in #3989; cached viewers can pair with older engine assets.
/** Optional ABI additions preserve the real staged older-WASM byte-taking contract. */
export interface SourcePrepassApi {
  scanEntityIndexShardFromSource?: (start: number, end: number) => ShardColumns;
  resolveStyledItemsShardFromSource?: (spans: Uint32Array) => ShardStyles;
  finalizePrepassStylesFromSource?: (...args: FinalizeStyleArgs) => Record<string, unknown>;
}

export interface ShardColumns {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
  classes: Uint8Array;
  handoff: number;
  oversizedIdStarts?: Uint32Array;
  malformedStart?: number;
}

export interface ShardStyles {
  orphanIds: Uint32Array;
  orphanColors: Float32Array;
  geomIds: Uint32Array;
  geomColors: Float32Array;
}

export type FinalizeStyleArgs = [
  orphanIds: Uint32Array, orphanColors: Float32Array,
  geomIds: Uint32Array, geomColors: Float32Array,
  colourMapSpans: Uint32Array, materialDefSpans: Uint32Array,
  relMaterialSpans: Uint32Array, voidSpans: Uint32Array,
  fillsSpans: Uint32Array, aggregateSpans: Uint32Array,
  planeAngleToRadians: number,
];

/** A missing/foreign token never authorizes reuse, even for equal-size sources.
 * SAB wrappers differ after postMessage, so object identity cannot prove this. */
export function canReuseWorkerSource(installed: string | undefined, requested: string | undefined): boolean {
  return requested !== undefined && installed === requested;
}
