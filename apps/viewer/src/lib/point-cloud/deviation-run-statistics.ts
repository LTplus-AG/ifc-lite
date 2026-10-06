/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The stored statistics of one BIM ↔ scan deviation run (#6872, #6833).
 *
 * The Deviation panel reads the signed distances back once per run and keeps
 * the array itself panel-local (4 B/point, needed for the histogram and the
 * tolerance band). The figures derived from it live in the store
 * (`pointCloudDeviationStatistics`) so the panel, the CSV export and the
 * assistant read ONE computation: the pooled summary over every point, the
 * per-asset summaries, and the within-tolerance counts for the tolerance the
 * user set. All passes are the renderer's sliced `…Async` variants.
 */

import {
  computeDeviationStatisticsAsync,
  countWithinToleranceAsync,
  summarizeDeviationAssetsAsync,
  type DeviationAssetSummary,
  type DeviationDistances,
  type DeviationStatistics,
} from '@ifc-lite/renderer';

/** Valid points with |d| ≤ tolerance, pooled and per asset (same order as `assets`). */
export interface DeviationToleranceCounts {
  /** Metres. */
  tolerance: number;
  overall: number;
  assets: readonly number[];
}

export interface PointCloudDeviationStatistics {
  /** `pointCloudDeviationRevision` of the run these figures were read back from. */
  revision: number;
  /** The `maxRange` the compute pass clamped |d| to, metres. */
  clipRange: number;
  /** Every point of every asset pooled: one pass, never a mean of the assets. */
  overall: DeviationStatistics;
  assets: readonly DeviationAssetSummary[];
  /** Null until the first tolerance pass for this readback lands. */
  withinTolerance: DeviationToleranceCounts | null;
}

/** Pooled and per-asset statistics of one readback. No histogram, no tolerance. */
export async function summarizeDeviationRun(
  distances: DeviationDistances,
  options: { clipRange: number; signal?: AbortSignal },
): Promise<Pick<PointCloudDeviationStatistics, 'overall' | 'assets'>> {
  const overall = await computeDeviationStatisticsAsync(distances.values, options);
  const assets = await summarizeDeviationAssetsAsync(distances, options);
  return { overall, assets };
}

/** Within-tolerance counts of one readback: one O(n) pass for the pool, one per asset slice. */
export async function countDeviationWithinTolerance(
  distances: DeviationDistances,
  tolerance: number,
  options: { signal?: AbortSignal } = {},
): Promise<DeviationToleranceCounts> {
  const overall = await countWithinToleranceAsync(distances.values, tolerance, options);
  const assets: number[] = [];
  for (const asset of distances.assets) {
    assets.push(await countWithinToleranceAsync(distances.values.subarray(asset.offset, asset.offset + asset.count), tolerance, options));
  }
  return { tolerance, overall, assets };
}

/** A stored summary with its tolerance share filled in, as the CSV report expects. */
export function withToleranceShare(statistics: DeviationStatistics, tolerance: number, count: number): DeviationStatistics {
  return { ...statistics,
    withinTolerance: { tolerance, count, share: statistics.validCount > 0 ? count / statistics.validCount : null } };
}
