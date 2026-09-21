/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Group evaluation (OR-of-AND-groups, #4904).
 *
 * Split out of `filter-evaluate.ts` (allowlisted at 583 lines,
 * `scripts/module-size-allowlist.txt`) rather than grown in place — the
 * ratchet forbids a listed file growing, and this needs its own home
 * regardless: it's the one seam where "groups" become a second concern
 * layered on top of the single-list evaluator, not a change to it.
 *
 * A `FilterGroup[]` ORs its groups together; within each group, the group's
 * own `combinator` still governs (mirrors the selector's `+`: AND within a
 * group, OR across groups). Rather than desugar this into a full-scan pass
 * over some merged rule list — a second matching path that could not answer
 * "why did this match" per-group, and could not be saved — each group is run
 * through the EXACT SAME per-entity evaluator as a single-group query
 * (`evaluateFilterRules(Federated)`), one call per group, unioned by
 * (modelId, expressId). A single group (the overwhelmingly common case,
 * and every query before #4904) takes this function's fast path straight
 * through to the existing single-list evaluator with zero extra overhead.
 *
 * This also means the AND+`op:in` index prefilter is NOT lost for
 * multi-group queries: each group still gets its own prefilter via
 * `selectIterationSource`, same as it would running alone. Measured on
 * `tests/models/buildingsmart/Building-Architecture.ifc` (the largest
 * fixture available on this host; see the PR body for the exact numbers) —
 * a two-group union costs about the sum of the two single-group runs, not a
 * full-scan multiple of it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { FilterGroup } from './filter-groups.js';
import {
  evaluateFilterRules,
  evaluateFilterRulesFederated,
  type EvaluateOptions,
  type FederatedEvaluateOptions,
  type FilteredElement,
  type EvaluatorModel,
} from './filter-evaluate.js';

const DEFAULT_LIMIT = 5_000;

function groupKey(el: FilteredElement): string {
  return `${el.modelId}:${el.expressId}`;
}

/** Sync entry — small candidate sets, tests. Mirrors `evaluateFilterRules`. */
export function evaluateFilterGroups(
  modelId: string,
  store: IfcDataStore,
  groups: readonly FilterGroup[],
  options: EvaluateOptions = {},
): FilteredElement[] {
  if (groups.length === 0) return [];
  if (groups.length === 1) {
    return evaluateFilterRules(modelId, store, groups[0].rules, groups[0].combinator, options);
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  const seen = new Set<string>();
  const out: FilteredElement[] = [];
  for (const group of groups) {
    if (out.length >= limit) break;
    if (group.rules.length === 0) continue;
    // Each group's OWN cap is the full `limit`, not `limit - out.length` —
    // review (PR #4987) caught that a shrinking per-group cap can underfill
    // the union: if THIS group's first N matches all duplicate ones an
    // earlier group already returned, capping it at the (small) remaining
    // budget stops the scan before its later, actually-unique matches are
    // ever reached. The outer `out.length >= limit` check above still skips
    // whole groups once the union is already full, and the inner loop below
    // still stops appending once it is; the only change is that a later
    // group may now be asked to find more candidates than strictly remain,
    // which costs some extra scanning but never drops a real match.
    const groupOut = evaluateFilterRules(modelId, store, group.rules, group.combinator, {
      ...options,
      limit,
    });
    for (const el of groupOut) {
      const key = groupKey(el);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Async federated entry — production UI path. Mirrors `evaluateFilterRulesFederated`. */
export async function evaluateFilterGroupsFederated(
  models: ReadonlyArray<EvaluatorModel>,
  groups: readonly FilterGroup[],
  options: FederatedEvaluateOptions = {},
): Promise<FilteredElement[]> {
  if (groups.length === 0) return [];
  if (groups.length === 1) {
    return evaluateFilterRulesFederated(models, groups[0].rules, groups[0].combinator, options);
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  const seen = new Set<string>();
  const out: FilteredElement[] = [];
  // A single-use candidate iterable (a generator, say) would be exhausted
  // by the first group's call and come back empty for every later one —
  // review (PR #4987). Materialize each model's candidates ONCE, up front,
  // so every group's `evaluateFilterRulesFederated` call gets its own fresh
  // pass over the same (now-array) candidate set.
  const candidatesByModel = options.candidateExpressIdsByModel
    ? new Map([...options.candidateExpressIdsByModel].map(([id, c]) => [id, [...c]] as const))
    : undefined;
  // Accumulate `scanned` ACROSS groups rather than handing each group's raw
  // per-group progress straight through — review (PR #4987) caught that
  // without this, a multi-group run's progress bar reached 100% at the end
  // of group 1 and then reset to 0% when group 2 started. `total` is
  // reported as -1 (unknown) for the whole multi-group run: the UI's own
  // progress renderer already has an unknown-total mode (a plain "scanned
  // N" count, no bar) for exactly this case, rather than a bar this
  // function would otherwise have to guess a cross-group total for.
  let scannedSoFar = 0;
  for (const group of groups) {
    if (out.length >= limit) break;
    if (group.rules.length === 0) continue;
    let lastGroupScanned = 0;
    // See the sync entry above (`evaluateFilterGroups`) for why this is
    // `limit`, not `limit - out.length`: a shrinking per-group cap can
    // underfill the union when a later group's early matches duplicate an
    // earlier group's.
    const groupOut = await evaluateFilterRulesFederated(models, group.rules, group.combinator, {
      ...options,
      candidateExpressIdsByModel: candidatesByModel,
      limit,
      onProgress: options.onProgress
        ? (scanned) => {
            lastGroupScanned = scanned;
            options.onProgress!(scannedSoFar + scanned, -1);
          }
        : undefined,
    });
    scannedSoFar += lastGroupScanned;
    for (const el of groupOut) {
      const key = groupKey(el);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
      if (out.length >= limit) break;
    }
  }
  return out;
}
