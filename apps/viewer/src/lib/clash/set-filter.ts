/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash set defined as an ADVANCED FILTER (#3902).
 *
 * A clash rule used to describe each of its two sets with one type-name
 * selector (`IfcDuct*|IfcPipe*`), which cannot say "external walls" or
 * "elements whose Pset_Revit_Phase.Phase is Existing". This module lets a
 * clash set be the SAME thing the viewer's advanced filter already is — a list
 * of `FilterRule`s combined with AND/OR — and resolves it with the SAME
 * evaluator (`evaluateFilterRulesFederated`). There is deliberately no second
 * predicate implementation to drift from the first: everything here is
 * plumbing between that evaluator and `ClashRule.membersA` / `membersB`.
 *
 * The type selector stays on the rule and stays authoritative for any side
 * with NO filter, so every preset saved before this existed runs exactly as it
 * did.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { clashMemberKey, type ClashRule } from '@ifc-lite/clash';
import { evaluateFilterRulesFederated } from '../search/filter-evaluate.js';
import { parseFilterRules, type Combinator, type FilterRule } from '../search/filter-rules.js';

/** One side of a clash rule, expressed the way the advanced filter is. */
export interface ClashSetFilter {
  combinator: Combinator;
  rules: FilterRule[];
}

/**
 * Cap on how many elements one side may resolve to. Far above any set a
 * coordinator would actually clash (the engine's own pair budget bites long
 * before this), but bounded so a filter over a 4M-entity federation cannot
 * build an unbounded array. The search modal's own default limit is far
 * lower, which is why this is passed explicitly rather than inherited.
 */
export const CLASH_SET_FILTER_LIMIT = 250_000;

/**
 * The filter if it has anything to say, otherwise undefined — a filter with no
 * rules is not a filter, and the side's selector still decides. The ONE
 * spelling of "does this side have a filter", used by the resolver and by
 * anything that displays one.
 */
export function activeClashSetFilter(
  filter: ClashSetFilter | undefined,
): ClashSetFilter | undefined {
  return filter && filter.rules.length > 0 ? filter : undefined;
}

/** One-line summary for the rule list ("2 rules · OR"). */
export function describeClashSetFilter(filter: ClashSetFilter): string {
  const n = filter.rules.length;
  const count = `${n} rule${n === 1 ? '' : 's'}`;
  // The combinator only says something once there are two rules to combine.
  return n > 1 ? `${count} · ${filter.combinator}` : count;
}

/**
 * Read a persisted filter. Returns undefined for anything that is not one —
 * including a preset stored before #3902 (no such field), a rule list that
 * survived nothing recognisable, and a blob from a newer/other app.
 */
export function parseClashSetFilter(raw: unknown): ClashSetFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { combinator?: unknown; rules?: unknown };
  if (!Array.isArray(r.rules)) return undefined;
  const rules = parseFilterRules(r.rules);
  if (rules.length === 0) return undefined;
  return { combinator: r.combinator === 'OR' ? 'OR' : 'AND', rules };
}

/** The subset of a loaded model this module needs. */
export interface ClashFilterModel {
  id: string;
  store: IfcDataStore | null;
}

/**
 * Resolve one filter to `ClashRule` member keys.
 *
 * The evaluator answers in `(modelId, expressId)` pairs — the LOCAL id space
 * of each store — while a `ClashElement.ref` is the FEDERATED id. `toGlobalId`
 * is the viewer's own mapping between them (`useViewerStore.toGlobalId`), the
 * same one `elementsFromStep` is handed, so the two sides agree by
 * construction rather than by both computing an offset.
 */
export async function resolveClashSetFilter(
  models: readonly ClashFilterModel[],
  filter: ClashSetFilter,
  toGlobalId: (modelId: string, expressId: number) => number,
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const matched = await evaluateFilterRulesFederated(models, filter.rules, filter.combinator, {
    limit: CLASH_SET_FILTER_LIMIT,
    signal: options.signal,
  });
  return matched.map((m) => clashMemberKey(m.modelId, toGlobalId(m.modelId, m.expressId)));
}

/** The A/B filters of one clash set definition. */
export type ClashSetFilters = { filterA?: ClashSetFilter; filterB?: ClashSetFilter };

/**
 * Resolve every filtered side of `rules` into explicit membership, leaving
 * unfiltered sides — and every rule with no filters at all — untouched.
 *
 * `sources` are the preset definitions the rules were built from, matched by
 * id (`rulesFromPresets` gives a rule its preset's id; `set-filter.test.ts`
 * pins that, because a rule that failed to find its filter would quietly run
 * its selector over everything instead).
 *
 * A filter that matches nothing resolves to an EMPTY member list rather than
 * to `undefined`: the engine reads the two apart (`members.ts`), and rounding
 * "matched nothing" up to "no filter" would silently run the rule over every
 * element its selector covers.
 *
 * Identical filters resolve ONCE. One filter is a full federation scan that
 * can parse property sets on demand, and reusing "external walls" as the A
 * side of five rules is the normal way a rule set is written.
 */
export async function withResolvedClashSetFilters(
  rules: readonly ClashRule[],
  sources: readonly (ClashSetFilters & { id: string })[],
  models: readonly ClashFilterModel[],
  toGlobalId: (modelId: string, expressId: number) => number,
  options: { signal?: AbortSignal } = {},
): Promise<ClashRule[]> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const resolved = new Map<string, Promise<string[]>>();
  const membersOf = (filter: ClashSetFilter): Promise<string[]> => {
    const key = JSON.stringify(filter);
    let pending = resolved.get(key);
    if (!pending) {
      pending = resolveClashSetFilter(models, filter, toGlobalId, options);
      resolved.set(key, pending);
    }
    return pending;
  };

  const out: ClashRule[] = [];
  for (const rule of rules) {
    const source = byId.get(rule.id);
    const a = activeClashSetFilter(source?.filterA);
    const b = activeClashSetFilter(source?.filterB);
    if (!a && !b) {
      out.push(rule);
      continue;
    }
    out.push({
      ...rule,
      ...(a ? { membersA: await membersOf(a) } : {}),
      ...(b ? { membersB: await membersOf(b) } : {}),
    });
  }
  return out;
}

/**
 * Read both persisted side filters off a stored preset, omitting whichever is
 * absent or unreadable — so a caller can spread the result into a projection
 * and a preset written before #3902 (or by a newer app) gains no fields.
 */
export function parseClashSetFilters(raw: unknown): ClashSetFilters {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as { filterA?: unknown; filterB?: unknown };
  const filterA = parseClashSetFilter(r.filterA);
  const filterB = parseClashSetFilter(r.filterB);
  return { ...(filterA ? { filterA } : {}), ...(filterB ? { filterB } : {}) };
}
