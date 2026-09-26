/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One worker's shard-resolved styled-item slice (`resolveStyledItemsShard`). */
export interface StylesSlice {
  orphanIds: Uint32Array; orphanColors: Float32Array;
  geomIds: Uint32Array; geomColors: Float32Array;
  /** #5582 `[metallic, roughness]` per geometry id; absent from an older wasm. */
  geomFinishes?: Float32Array;
  error?: string;
}

/** The merged columns `finalizePrepassStyles` consumes. */
export interface MergedShardStyles {
  orphanIds: Uint32Array; orphanColors: Float32Array;
  geomIds: Uint32Array; geomColors: Float32Array;
  /** Two floats per `geomIds` entry, NaN where a slice carried no finish. */
  geomFinishes: Float32Array;
}

/**
 * Merge the shard-resolved style maps IN SLICE ORDER with first-wins per id,
 * reproducing the serial resolver's file-order precedence. A geometry id's
 * finish comes from the same slice as its colour, so the winner's colour and
 * finish can never come from two different styled items.
 */
export function mergeShardStyleSlices(slices: readonly (StylesSlice | null)[]): MergedShardStyles {
  const orphanSeen = new Set<number>();
  const geomSeen = new Set<number>();
  const orphanWin: Array<[number, StylesSlice, number]> = [];
  const geomWin: Array<[number, StylesSlice, number]> = [];
  for (const slice of slices) {
    if (!slice) continue;
    if (slice.error) console.warn(`[stream][shard] style slice failed (degraded colours possible): ${slice.error}`);
    for (let i = 0; i < slice.orphanIds.length; i++) {
      const id = slice.orphanIds[i];
      if (!orphanSeen.has(id)) { orphanSeen.add(id); orphanWin.push([id, slice, i]); }
    }
    for (let i = 0; i < slice.geomIds.length; i++) {
      const id = slice.geomIds[i];
      if (!geomSeen.has(id)) { geomSeen.add(id); geomWin.push([id, slice, i]); }
    }
  }
  const orphanIds = new Uint32Array(orphanWin.length);
  const orphanColors = new Float32Array(orphanWin.length * 4);
  orphanWin.forEach(([id, slice, i], k) => {
    orphanIds[k] = id;
    orphanColors.set(slice.orphanColors.subarray(i * 4, i * 4 + 4), k * 4);
  });
  const geomIds = new Uint32Array(geomWin.length);
  const geomColors = new Float32Array(geomWin.length * 4);
  const geomFinishes = new Float32Array(geomWin.length * 2).fill(NaN);
  geomWin.forEach(([id, slice, i], k) => {
    geomIds[k] = id;
    geomColors.set(slice.geomColors.subarray(i * 4, i * 4 + 4), k * 4);
    // Length-guarded: a short or missing finish column leaves this id NaN.
    const finishes = slice.geomFinishes;
    if (finishes && i * 2 + 1 < finishes.length) geomFinishes.set(finishes.subarray(i * 2, i * 2 + 2), k * 2);
  });
  return { orphanIds, orphanColors, geomIds, geomColors, geomFinishes };
}
