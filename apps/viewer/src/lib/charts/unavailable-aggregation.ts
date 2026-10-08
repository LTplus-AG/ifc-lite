/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Aggregation } from '@ifc-lite/charts';

/**
 * The aggregation of a bound chart whose saved content is gone (#6947). The
 * card, the document preview and both PDFs read "no data" from an aggregation
 * without buckets, but an Element Count always has its one `Total` bucket, so
 * over the empty rows of a missing source it would draw a total of 0. A
 * missing source has no total: this removes the buckets, and with them the
 * number, for every chart type alike.
 */
export function withoutBuckets<T extends Aggregation>(aggregation: T): T {
  return { ...aggregation, categories: [], series: [], total: 0, categoryOf: new Map() };
}
