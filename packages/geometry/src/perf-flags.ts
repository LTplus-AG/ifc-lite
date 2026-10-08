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

import { readPerfFlagRaw, type PerfFlagBinding } from '@ifc-lite/data';
import type { BatchSizingConfig } from './batch-sizing.js';

export const GEOMETRY_PERF_FLAG_BINDINGS = {
  /** Adaptive batch-sizing override (#1097); JSON `Partial<BatchSizingConfig>`. */
  batchSizing: { global: '__IFC_LITE_BATCH_SIZING', urlParam: 'perf.batchSizing' },
  /** Load-time visibility filter (#1097); JSON `{ disabledTypes, skipTypeGeometry }`. */
  visibilityFilter: { global: '__IFC_LITE_VISIBILITY_FILTER', urlParam: 'perf.visibilityFilter' },
  /** Sharded entity-index pre-pass; on by default, `0` is the kill switch. */
  shardScan: { global: '__IFC_LITE_SHARD_SCAN', urlParam: 'perf.shardScan' },
  /** Engine init + geometry workers started at load request (#7036); on by default, `0` is the kill switch. */
  warmPool: { global: '__IFC_LITE_WARM_POOL', urlParam: 'perf.warmPool' },
} as const satisfies Record<string, PerfFlagBinding>;

/**
 * Optional runtime override for the geometry worker's adaptive batch sizing
 * (#1097), read off `globalThis` on the host thread. A zero-cost escape hatch
 * for hardware-specific tuning / field-debugging the watchdog↔throughput
 * trade-off without a rebuild; unset ⇒ the worker uses DEFAULT_BATCH_SIZING.
 * Validation/merge happens in the worker via `resolveBatchSizing`.
 */
export function readBatchSizingOverride(): Partial<BatchSizingConfig> | undefined {
  const v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.batchSizing);
  return v && typeof v === 'object' ? (v as Partial<BatchSizingConfig>) : undefined;
}

/**
 * Optional load-time visibility filter (#1097), read off `globalThis` on the
 * host thread (tuning / benchmarking escape hatch). `{ disabledTypes,
 * skipTypeGeometry }` skip the matching geometry jobs at the prepass so they're
 * never decoded/meshed/uploaded. Unset ⇒ load everything.
 */
export function readVisibilityFilterOverride(): { disabledTypes?: string[]; skipTypeGeometry?: boolean } | undefined {
  const v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.visibilityFilter);
  return v && typeof v === 'object' ? (v as { disabledTypes?: string[]; skipTypeGeometry?: boolean }) : undefined;
}

/**
 * SPIKE flag: shard the entity-index scan across the idle geometry workers and
 * deliver the stitched index early, instead of waiting for the pre-pass
 * worker's single-threaded post-scan `entity-index` emission. Read off
 * `globalThis.__IFC_LITE_SHARD_SCAN` (benchmark A/B knob). Truthy ⇒ on.
 */
export function readShardScanFlag(): boolean {
  const v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.shardScan);
  // ON by default; 0/'0'/false is the kill switch (same convention as the
  // other #1682 load/render knobs).
  if (v === 0 || v === '0' || v === false) return false;
  return true;
}

/**
 * Prewarmed workers (#7036): a host starts a load's geometry and pre-pass
 * workers when the load is requested, beside the file read. Opt-in while the
 * end-to-end verdict is pending; 1/'1'/true enables the experiment.
 */
export function readWarmPoolFlag(): boolean {
  const v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.warmPool);
  return v === 1 || v === '1' || v === true;
}
