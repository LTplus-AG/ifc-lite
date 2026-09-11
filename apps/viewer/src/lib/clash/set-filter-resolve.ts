/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolving a clash set filter (`./set-filter.ts`) to the elements it selects.
 *
 * It runs the SAME evaluator the search panel runs
 * (`evaluateFilterRulesFederated`): there is deliberately no second predicate
 * implementation to drift from the first, so everything here is plumbing
 * between that evaluator and `ClashRule.membersA` / `membersB`.
 *
 * Split from the definition half because this import chain reaches the parser,
 * and the clash store slice loads the definitions (through `persistence.ts`)
 * on the boot path.
 */

import { clashMemberKey, type ClashRule } from '@ifc-lite/clash';
import { evaluateFilterRulesFederated, type EvaluatorModel } from '../search/filter-evaluate.js';
import { unresolvedModelTagIds } from '../model-tags/types.js';
import {
  CLASH_SET_FILTER_LIMIT,
  activeClashSetFilter,
  type ClashSetFilter,
  type ClashSetFilters,
} from './set-filter.js';

export interface ResolveClashSetFilterOptions {
  signal?: AbortSignal;
  /** Largest set that may resolve; defaults to {@link CLASH_SET_FILTER_LIMIT}. */
  limit?: number;
  /** Every model tag that exists (#4215). A filter naming any other tag id is
   *  REFUSED — see `resolveClashSetFilter`. Absent means no tags exist. */
  definedModelTagIds?: ReadonlySet<string>;
}

/** The subset of a loaded model this module needs — exactly what the evaluator
 *  reads, including the model's tag set as of the call (#4215). Built by
 *  `evaluatorModelsFromState` from ONE state snapshot, so every side of every
 *  rule in a run resolves against the same memberships. */
export type ClashFilterModel = EvaluatorModel;

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
  options: ResolveClashSetFilterOptions = {},
): Promise<string[]> {
  const limit = options.limit ?? CLASH_SET_FILTER_LIMIT;
  // A rule naming a tag that no longer exists is unresolved. The evaluator
  // would match it against nothing, which for a clash run is the WRONG kind of
  // safe: a side that quietly resolves to zero members reports zero clashes
  // with nothing on screen to say the rule was broken. Refuse instead (#4215).
  const defined = options.definedModelTagIds ?? new Set<string>();
  const unresolved = filter.rules.flatMap((r) => (r.kind === 'modelTag' ? unresolvedModelTagIds(r, defined) : []));
  if (unresolved.length > 0) {
    throw new Error(
      `A clash set filter refers to ${unresolved.length === 1 ? 'a model tag' : `${unresolved.length} model tags`} that no longer exist${unresolved.length === 1 ? 's' : ''}. ` +
        'Fix or remove that rule — the run was refused rather than widened to models the rule never named.',
    );
  }
  // Ask for one past the cap so a set that lands EXACTLY on it is told apart
  // from one the evaluator stopped short of.
  const matched = await evaluateFilterRulesFederated(models, filter.rules, filter.combinator, {
    limit: limit + 1,
    signal: options.signal,
    definedModelTagIds: options.definedModelTagIds,
  });
  if (matched.length > limit) {
    throw new Error(
      `A clash set filter matched more than ${limit.toLocaleString()} elements. ` +
        'Narrow it — a run over a truncated set would report fewer clashes than the model has.',
    );
  }
  return matched.map((m) => clashMemberKey(m.modelId, toGlobalId(m.modelId, m.expressId)));
}

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
  options: ResolveClashSetFilterOptions = {},
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
