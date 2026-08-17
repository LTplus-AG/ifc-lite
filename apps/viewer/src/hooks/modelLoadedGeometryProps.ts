/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryDiagnostics, TessellationQuality } from '@ifc-lite/geometry';

/**
 * Geometry-attribution properties for the `ifc_model_loaded` event (issue #2388).
 *
 * #2388 observed the SAME file on the SAME build reporting two different
 * `total_triangles` with an identical `mesh_count`, i.e. the extra triangles are
 * distributed *within* existing meshes. `total_triangles` alone cannot say which
 * of the geometry pipeline's environment-conditional inputs moved, because none
 * of them rode the event:
 *
 *  - `totalCsgFailures` reached the main thread on the streaming `complete`
 *    event but was only `console.info`'d (`useIfcLoader`, added in #1439) — it
 *    was never captured, so no historical load can be attributed at all.
 *  - `skipSmallCuts` (viewer `geometryMode`) and the load-time tessellation tier
 *    (`resolveLoadTessellationTier`, plus the persisted `?geomTier=` override and
 *    the resource-retry downgrade to `lowest`) BOTH change per-element triangle
 *    counts while leaving the mesh roster untouched — the exact signature of
 *    #2388 — and BOTH are resolved from `localStorage`, so two browsers on one
 *    build legitimately mesh the same file differently. Neither records a CSG
 *    failure: the small-cut skip returns the un-cut host with no `record_failure`
 *    call at all (`rust/geometry/src/processors/boolean/mod.rs`), so a load that
 *    differs only by these reports `total_csg_failures: 0`.
 *
 * Absent diagnostics stay ABSENT rather than being flattened to `0`. A fabricated
 * zero would read as "CSG ruled out" on a load where the counter never arrived,
 * which is precisely the mis-attribution this field exists to prevent.
 */
export interface ModelLoadedGeometryPropsInputs {
  /** `diagnostics` from the geometry stream's `complete` event, if any producer emitted it. */
  diagnostics: GeometryDiagnostics | null | undefined;
  /** The tier handed to the GeometryProcessor; `undefined`/`null` = engine default (medium). */
  tessellationTier: TessellationQuality | null | undefined;
  /** The small-cut skip the load actually ran with (viewer `geometryMode === 'fast'`). */
  skipSmallCuts: boolean;
  /**
   * True when this load is the automatic retry that a resource-limit failure
   * started (`resolveResourceRetryTier` -> `loadFile({ isResourceRetry: true })`).
   *
   * The tier ALONE cannot say this. `resolveResourceRetryTier` always returns
   * `'lowest'` when it retries (`lib/resource-retry.ts`), and a FIRST attempt
   * independently resolves to `'lowest'` for any `fast`-mode file at or above
   * `AUTO_LOWEST_TIER_MB = 150` or under a pinned `?geomTier=lowest`
   * (`store/geometryFidelity.ts:187-196`) — so `tessellation_tier: 'lowest'`
   * describes a degraded reload and a normal large-file load identically. The
   * flag is threaded from the load's own options rather than inferred from the
   * tier, because inferring it would re-create exactly that ambiguity.
   */
  isResourceRetry: boolean;
}

/** PostHog property bag; `undefined` values are dropped by posthog-js. */
export function buildModelLoadedGeometryProps(
  inputs: ModelLoadedGeometryPropsInputs,
): Record<string, string | number | boolean | undefined> {
  const d = inputs.diagnostics ?? undefined;
  return {
    total_csg_failures: d?.totalCsgFailures,
    csg_products_with_failures: d?.productsWithFailures,
    csg_silent_no_ops: d?.silentNoOps,
    // `failuresByReason` is sorted desc by count by the producer/merger, so [0]
    // is the dominant reason. Omitted when nothing failed.
    csg_top_failure_reason: d?.failuresByReason?.[0]?.reason,
    // `undefined` from `resolveLoadTessellationTier` IS the engine default —
    // report it by name so it is distinguishable from a build that sent nothing.
    tessellation_tier: inputs.tessellationTier ?? 'medium',
    skip_small_cuts: inputs.skipSmallCuts,
    // `false` MUST survive to the wire: it is the statement "this load was a
    // normal first attempt", which is what separates a degraded reload from a
    // large-file load that resolved to the same tier on its own.
    is_resource_retry: inputs.isResourceRetry,
  };
}
