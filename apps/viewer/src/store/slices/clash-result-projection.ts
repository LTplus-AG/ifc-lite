/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { groupClashes, type ClashResult } from '@ifc-lite/clash';
import { applyClashExclusions, type ClashExclusionRule } from '@/lib/clash/exclusions';
import type { ClashSlice } from './clashSlice';

/**
 * Everything derived from (raw result × exclusion rules): the filtered result,
 * its clusters, each rule's reach and the suppressed total — PLUS the single
 * gate that keeps this derivation from clobbering a `'manual'` grouping it did
 * not produce (`setClashGroups`, the duplicate scan's coincident-SET view).
 *
 * `clashResult` / `clashExclusionCounts` / `clashSuppressedCount` are always
 * recomputed from `raw` — exclusions must keep filtering a duplicate scan's
 * result too. Only the `clashGroups` field is gated: this is `@ifc-lite/clash`
 * grouping module (spatial clusters, no per-run identity), not a duplicate-
 * scan detector, and it must never overwrite a grouping some OTHER writer
 * produced unless it also owns a genuinely new raw result to derive from.
 *
 * `newRun` distinguishes the two situations that call this:
 * - `true` (only from `setClashResult`): `raw` just changed — a real
 *   detection/scan completed. Any prior manual override was for the
 *   PREVIOUS run's clashes, which no longer exist, so it is superseded
 *   unconditionally.
 * - `false` (`setClashClusterEpsilon`, `commitExclusions`): `raw` is
 *   UNCHANGED — nothing was re-run, only a setting changed. This derivation
 *   did not produce the current `'manual'` grouping (if any) and has no basis
 *   to replace it, so it leaves `clashGroups`/`clashGroupsKind` alone.
 *
 * This is the ONLY place `clashGroups` is computed from `clashRawResult` — a
 * future re-derivation site should route through here (not call
 * `groupClashes` directly) to inherit the guard for free.
 */
export function deriveGroups(
  state: Pick<ClashSlice, 'clashGroups' | 'clashGroupsKind'>,
  raw: ClashResult | null,
  rules: readonly ClashExclusionRule[],
  clusterEpsilon: number,
  newRun: boolean,
): Pick<ClashSlice, 'clashResult' | 'clashGroups' | 'clashGroupsKind' | 'clashExclusionCounts' | 'clashSuppressedCount'> {
  const { result, counts, suppressed } = applyClashExclusions(raw, rules);
  if (!newRun && state.clashGroupsKind === 'manual') {
    return {
      clashResult: result,
      clashGroups: state.clashGroups,
      clashGroupsKind: 'manual',
      clashExclusionCounts: counts,
      clashSuppressedCount: suppressed,
    };
  }
  const clashGroups = result ? groupClashes(result, { by: 'cluster', epsilon: clusterEpsilon }) : null;
  return {
    clashResult: result,
    clashGroups,
    clashGroupsKind: clashGroups ? 'derived' : null,
    clashExclusionCounts: counts,
    clashSuppressedCount: suppressed,
  };
}
