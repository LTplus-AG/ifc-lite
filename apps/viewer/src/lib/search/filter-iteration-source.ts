/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Iteration-source selection (index prefilter) and cheap-first rule
 * ordering for the path-B evaluator.
 *
 * Split out of `filter-evaluate.ts` (which keeps the orchestration /
 * per-entity loop) to stay under the module size cap — both pieces here are
 * pure given `store`/`rules`, which is what makes them unit-testable without
 * an `EvalContext`.
 */

import type { IfcDataStore } from '@ifc-lite/parser';

import type { Combinator, FilterRule } from './filter-rules.js';
import { unionByStorey } from './filter-match.js';

// ── Iteration source: index prefilter (AND + op:in) ──────────────────────────

/** Return the raw expressId column as the iteration source. The per-entity
 *  loops already skip empty rows (`if (!expressId) continue`) so the
 *  typed-array shape is correctness-safe AND lets the federated entry report
 *  a `total` rather than streaming with `total = -1`. */
export function iterateAllExpressIds(store: IfcDataStore): ArrayLike<number> {
  return store.entities.expressId;
}

/**
 * Decide which expressIds the evaluator walks. Public for testability —
 * consumers should only depend on the results returned, not on the
 * iteration count, but a benchmark / regression test may want to assert
 * the prefilter actually narrows.
 */
export function selectIterationSource(
  store: IfcDataStore,
  rules: readonly FilterRule[],
  combinator: Combinator,
  candidateExpressIds: Iterable<number> | undefined,
  modelId?: string,
): ArrayLike<number> | Iterable<number> {
  // Caller-supplied narrowing wins (Tier-1 candidates).
  if (candidateExpressIds !== undefined) return candidateExpressIds;

  // Prefilter only applies under AND. OR rules are unioned; you can't
  // shrink the candidate set from a single OR clause without losing
  // results from the other clauses.
  if (combinator !== 'AND') return iterateAllExpressIds(store);

  // Try to find the smallest narrowing source. Multiple op:in rules in
  // the same query can each suggest a candidate bucket; we pick the
  // smallest one (the per-entity loop re-checks every rule, so any one
  // valid bucket is correctness-safe — fewer rows = less work).
  let best: number[] | null = null;

  for (const rule of rules) {
    if (rule.kind === 'ifcType' && rule.op === 'in' && rule.values.length > 0) {
      const bucket = unionByType(store, rule.values);
      if (bucket && (best === null || bucket.length < best.length)) best = bucket;
    } else if (rule.kind === 'storey' && rule.op === 'in' && rule.values.length > 0) {
      const bucket = unionByStorey(store, rule, modelId);
      if (bucket && (best === null || bucket.length < best.length)) best = bucket;
    }
  }

  return best ?? iterateAllExpressIds(store);
}

function unionByType(store: IfcDataStore, names: readonly string[]): number[] | null {
  const byType = store.entityIndex.byType;
  if (!byType || byType.size === 0) return null;
  // STEP type names are stored UPPERCASE; rule values arrive in canonical
  // PascalCase ("IfcWall") so we uppercase here at the boundary.
  const out: number[] = [];
  for (const name of names) {
    const bucket = byType.get(name.toUpperCase());
    if (bucket) for (const id of bucket) out.push(id);
  }
  return out.length > 0 ? out : null;
}

// ── Cheap-first rule ordering ────────────────────────────────────────────────

/**
 * AGENTS.md §2: never call `extractPropertiesOnDemand` in a large loop.
 * We can't avoid it entirely for `property`/`quantity` rules, but we can
 * make sure cheap rules check first so AND/OR short-circuit skips the
 * expensive parse for entities that already fail/pass.
 */
const RULE_COST: Record<FilterRule['kind'], number> = {
  // Constant-time comparison against the entity's owning model.
  model:          0,
  // Column-only — single TypedArray read.
  ifcType:        0,
  // Pre-built reverse-map lookup.
  storey:         1,
  // Pre-built reverse-map lookup (elementToStorey → storeyElevations).
  elevation:      1,
  // String-table indirection.
  name:           2,
  // Column-only — same TypedArray read as ifcType, just a different column.
  globalId:       0,
  // Source-buffer parse (resolveEntityPredefinedType re-reads the entity's
  // attributes) - same cost class as a pset parse, so order it after the
  // cheap column checks that can short-circuit it. (#1462)
  predefinedType: 10,
  // Source-buffer parse (the AGENTS.md §2 hot path).
  property:       10,
  quantity:       10,
  // Source-buffer parse (extractAllEntityAttributes) — same cost class.
  attribute:      10,
  // Relationship-graph walk + on-demand resolve — as costly as a pset parse.
  material:       10,
  classification: 10,
};

export function orderRulesByCost(rules: readonly FilterRule[]): FilterRule[] {
  // Stable sort — equal-cost rules retain their authored order so the
  // user's intent is visible in debug logs / SQL preview.
  return rules
    .map((r, i) => ({ r, i, cost: RULE_COST[r.kind] }))
    .sort((a, b) => a.cost - b.cost || a.i - b.i)
    .map((x) => x.r);
}
