/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One repack of the Gaussian layer's assets on a device (#9018). Kept rows are
 * GPU-copied from the drawn pack when its SH layout still fits; every other asset
 * is read again from its canonical row source at its placement. No CPU copy of
 * any asset's rows is made; only the sort columns are returned.
 */

import type { GaussianBackendScene } from './gaussian-backend.js';
import type { GaussianOps } from './gaussian-lazy.js';
import type { PackEntry, PackedScene, ShDegree } from './gaussian-pack.js';
import type { SimilarityPlacement } from './gaussian-placement.js';
import type { GaussianRowSource } from './gaussian-rows.js';
import type { GaussianSplatBounds, GaussianSplatHandle } from './gaussian-types.js';

export interface GaussianAssetRecord {
  readonly handle: GaussianSplatHandle;
  readonly slot: number;
  readonly degree: ShDegree;
  readonly count: number;
  /** The canonical rows; null once the asset is removed or failed. */
  rows: GaussianRowSource | null;
  /** Local placement of the committed rows, and the model translation they used. */
  committed: SimilarityPlacement;
  translation: readonly [number, number, number] | undefined;
  /** Latest requested local placement; model re-placement always starts from it. */
  requested: SimilarityPlacement;
  visible: boolean;
  failure: string | null;
  bounds: GaussianSplatBounds;
}

/**
 * Upload a new pack of `live` into `scene`. A slot keeps its rows by a GPU copy
 * when `previous` (the pack drawn on this device, if any) holds them in the same
 * SH layout; `reads` (and every slot that cannot be copied) are read again from
 * their sources at their placement. On failure the backend has released the new
 * allocation; `check` outranks the upload error.
 */
export async function uploadRepack(
  ops: GaussianOps, device: GPUDevice, scene: GaussianBackendScene, previous: PackedScene | null,
  live: readonly GaussianAssetRecord[], reads: ReadonlyMap<GaussianAssetRecord, SimilarityPlacement>,
  anchor: readonly [number, number, number], check: () => void,
): Promise<{ scene: PackedScene; bounds: Map<number, GaussianSplatBounds> }> {
  const shDegree = Math.max(0, ...live.map((r) => r.degree)) as ShDegree;
  const shEncoding = ops.shEncodingFor(live.map((r) => r.rows!), shDegree);
  const sameLayout = previous?.layout.shDegree === shDegree && previous.layout.shEncoding === shEncoding;
  const entries: PackEntry[] = live.map((r) => {
    const placement = reads.get(r);
    if (!placement && sameLayout && previous!.slices.has(r.slot)) return { slot: r.slot, kind: 'copy', rows: r.count };
    return { slot: r.slot, kind: 'read', source: r.rows!, placement: placement ?? ops.placeInWorld(r.committed, r.translation) };
  });
  const { rows, slices } = ops.layoutSlices(live.map((r) => ({ slot: r.slot, rows: r.count })));
  const layout = { rows, shDegree, shEncoding };
  ops.assertPackedBudget(layout, device.limits);
  let bounds = new Map<number, GaussianSplatBounds>();
  let sort: PackedScene['sort'] | null = null;
  try {
    await scene.replaceRows(layout, async (writer) => {
      const filled = await ops.fillPacked(writer, layout, slices, entries, previous, anchor, check);
      bounds = filled.bounds;
      sort = filled.sort;
      return filled.sort;
    });
  } catch (error) {
    check(); // a clear or loss outranks the upload error
    throw error;
  }
  return { scene: { layout, sort: sort!, slices }, bounds };
}
