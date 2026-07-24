/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';
import type { LoadErrorKind } from './load-errors.js';

/**
 * Decide whether a failed model load should be auto-retried at a lower
 * tessellation tier, and at which one.
 *
 * A load can fail because the model is genuinely too heavy for the device's
 * memory: the geometry stream watchdog fires (`geometry_stream_stalled`), a
 * worker is OOM-killed (`geometry_worker_crash`), or a JS/ArrayBuffer
 * allocation fails (`out_of_memory`). These are the three biggest error-tracking
 * families and today they dead-end with a "close tabs / load something smaller"
 * message. But the engine can tessellate the SAME model far more cheaply — the
 * `lowest` tier drops parametric fillets to sharp corners and coarsens curves,
 * cutting triangle count (and therefore peak memory) dramatically. A model that
 * OOM'd at the default density has a real chance to load at `lowest`.
 *
 * So on one of these resource failures we retry the same in-memory file once at
 * `lowest`. Deciding this is a pure function so the policy is unit-tested; the
 * `useIfcLoader` catch is a thin call site.
 *
 * Guard rails encoded here:
 *  - Only the three resource-exhaustion kinds qualify. A parse error, a cancel,
 *    or an engine-load failure is not made better by less detail.
 *  - Only when the failing load actually ran the WASM tessellation path
 *    (`attemptedTier` is set). A GLB / point-cloud / server load is not
 *    re-tessellated by our engine, so a lower IFC tier would not change its
 *    memory and must not trigger a pointless reload of work.
 *  - Only for a PRIMARY load. A federated add must never silently downgrade the
 *    whole federation's detail.
 *  - Only once: `alreadyRetried` short-circuits so the `lowest`-tier attempt,
 *    if it also fails, surfaces the error instead of looping.
 *  - Only when we are not already at `lowest` — there is nowhere lower to go.
 */

/** The tessellation kinds whose failure a lower tier can plausibly fix. */
const RESOURCE_LIMIT_KINDS: ReadonlySet<LoadErrorKind> = new Set<LoadErrorKind>([
  'out_of_memory',
  'geometry_worker_crash',
  'geometry_stream_stalled',
]);

export interface ResourceRetryInputs {
  /** Classified failure kind (see classifyLoadError). */
  kind: LoadErrorKind;
  /**
   * The tessellation tier the failing load actually used, or `null` if the
   * failing load never ran the WASM tessellation path (GLB / point-cloud /
   * server / cache — a lower IFC tier cannot help those). `undefined` means the
   * WASM path ran at the engine default (medium).
   */
  attemptedTier: TessellationQuality | null | undefined;
  /** True for a destructive primary load; false for a federated add. */
  isPrimary: boolean;
  /** True if this load is ITSELF an auto-retry, so we don't loop. */
  alreadyRetried: boolean;
}

/**
 * The tier to retry at, or `null` to not retry (surface the error normally).
 *
 * Always `lowest` when a retry is warranted: it is the maximal memory reduction
 * in one step, so a single retry gives the best chance to fit rather than
 * grinding the user through medium → low → lowest across several failed loads.
 */
export function resolveResourceRetryTier(
  inputs: ResourceRetryInputs,
): TessellationQuality | null {
  if (inputs.alreadyRetried) return null;
  if (!inputs.isPrimary) return null;
  if (!RESOURCE_LIMIT_KINDS.has(inputs.kind)) return null;
  // `null` attemptedTier = the WASM tessellation path never ran → a lower tier
  // is meaningless. `'lowest'` = nowhere lower to go.
  if (inputs.attemptedTier === null) return null;
  if (inputs.attemptedTier === 'lowest') return null;
  return 'lowest';
}
