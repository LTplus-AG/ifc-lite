/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bucket a 3D snapshot frames. `categories` is in DISPLAY order — by
 * value for a plain bar, but by label, bin or week for a label-sorted,
 * histogram or timeline chart — so "the largest bucket" is chosen by its
 * value, never by its position.
 */
import type { Aggregation } from '@ifc-lite/charts';

export function largestBucketIds(aggregation: Aggregation | null | undefined): number[] {
  if (!aggregation || aggregation.categories.length === 0) return [];
  let best = aggregation.categories[0];
  for (const bucket of aggregation.categories) if (bucket.value > best.value) best = bucket;
  return Array.from(best.ids);
}
