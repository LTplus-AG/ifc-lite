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
  /** Decide GPU instancing once per model (global instance plan). Off by default. */
  globalInstancing: { global: '__IFC_LITE_GLOBAL_INSTANCING', urlParam: 'perf.globalInstancing' },
  /** Out-of-core ingest: geometry workers mesh from a sparse arena fed by range reads. Off by default. */
  outOfCore: { global: '__IFC_LITE_OOC', urlParam: 'perf.ooc' },
  /** Out-of-core ingest: per-worker sparse arena budget in MiB. */
  outOfCoreBudgetMb: { global: '__IFC_LITE_OOC_BUDGET_MB', urlParam: 'perf.oocBudgetMb' },
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

let globalInstancingRamp: (() => unknown) | undefined;

/**
 * The host's staged rollout for the plan (the viewer's PostHog ramp), asked only when neither the global nor
 * the URL param is set, so an explicit `0` or `1` always wins. `undefined` removes it.
 */
export function setGlobalInstancingRamp(read: (() => unknown) | undefined): void {
  globalInstancingRamp = read;
}

/**
 * Global instance plan: decide GPU instancing ONCE per model from the
 * pre-pass's model-wide facts (mapped-item counts, repeated content keys)
 * instead of per batch. Off by default (the per-batch decision); `1`/true arms
 * it. Read on the host thread when a load starts.
 */
export function readGlobalInstancingFlag(): boolean {
  let v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.globalInstancing);
  if (v === undefined) {
    try { v = globalInstancingRamp?.(); } catch { v = undefined; } // a failing ramp read keeps the default
  }
  return v === 1 || v === '1' || v === true || v === 'true';
}

/**
 * Smallest source the plan applies to: the viewer's uncached small-file tier
 * (its fast path, `FAST_PATH_MAX_BYTES`, which pins this value) keeps the
 * per-batch decision. A small model gains little from model-wide templates,
 * and deciding by the file alone keeps every load of one file, fast path or
 * pool, cold or reopened, on the same instancing.
 */
export const GLOBAL_INSTANCING_MIN_BYTES = 10 * 1024 * 1024;

/** The small-file tier: the viewer's fast path takes these files, the global instance plan never applies to them.
 *  One predicate for both sides, so no size is ever both or neither. */
export function inSmallFileTier(byteLength: number): boolean {
  return byteLength < GLOBAL_INSTANCING_MIN_BYTES;
}

/** Whether the plan applies to a source of `byteLength` bytes (the bytes the pool meshes: for a compressed source,
 *  its decompressed IFC): the flag is on and the source is past the small tier. */
export function globalInstancingApplies(byteLength: number): boolean {
  return !inSmallFileTier(byteLength) && readGlobalInstancingFlag();
}

/**
 * Out-of-core geometry ingest (`geometry-parallel-sparse.ts`): workers hold a
 * bounded sparse arena fed by range reads instead of a full source copy and
 * their own index. Off by default; `1`/true arms it. Read on the host thread
 * when a load starts.
 */
export function readOutOfCoreFlag(): boolean {
  const v = readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.outOfCore);
  return v === 1 || v === '1' || v === true || v === 'true';
}

/** Per-worker sparse arena budget in bytes (default 192 MiB). */
export function readOutOfCoreBudgetBytes(): number {
  const v = Number(readPerfFlagRaw(GEOMETRY_PERF_FLAG_BINDINGS.outOfCoreBudgetMb));
  return (Number.isFinite(v) && v > 0 ? v : 192) * 1024 * 1024;
}
