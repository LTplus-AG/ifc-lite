/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bindings of the perf flags the geometry host reads (#6962). Declared here,
 * not in the viewer registry, because this package must not import the
 * viewer; `apps/viewer/src/lib/perf/flags.ts` spreads these into its entries
 * and adds the owner / removal-condition metadata. All reads go through
 * `readPerfFlagRaw` from `@ifc-lite/data`.
 */

import type { PerfFlagBinding } from '@ifc-lite/data';

export const GEOMETRY_PERF_FLAG_BINDINGS = {
  /** Adaptive batch-sizing override (#1097); JSON `Partial<BatchSizingConfig>`. */
  batchSizing: { global: '__IFC_LITE_BATCH_SIZING', urlParam: 'perf.batchSizing' },
  /** Load-time visibility filter (#1097); JSON `{ disabledTypes, skipTypeGeometry }`. */
  visibilityFilter: { global: '__IFC_LITE_VISIBILITY_FILTER', urlParam: 'perf.visibilityFilter' },
  /** Sharded entity-index pre-pass; on by default, `0` is the kill switch. */
  shardScan: { global: '__IFC_LITE_SHARD_SCAN', urlParam: 'perf.shardScan' },
} as const satisfies Record<string, PerfFlagBinding>;
