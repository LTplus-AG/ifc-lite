/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash set defined as an ADVANCED FILTER (#3902).
 *
 * A clash rule used to describe each of its two sets with one type-name
 * selector (`IfcDuct*|IfcPipe*`), which cannot say "external walls" or
 * "elements whose Pset_Revit_Phase.Phase is Existing". A set may instead be
 * the SAME thing the viewer's advanced filter already is — a list of
 * `FilterRule`s combined with AND/OR.
 *
 * This half is the DEFINITION: the shape, its persisted form, and how it
 * reads. `set-filter-resolve.ts` turns one into element membership, and is
 * deliberately a separate module because it pulls in the search evaluator (and
 * with it the parser) — `persistence.ts` needs only the parsing here, and is
 * imported by the store slice on the boot path.
 *
 * The type selector stays on the rule and stays authoritative for any side
 * with NO filter, so every preset saved before this existed runs exactly as it
 * did.
 */

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
 *
 * Reaching it FAILS the run (see `resolveClashSetFilter`). The evaluator
 * stops scanning at its limit, so a capped set is a silently smaller set —
 * and a clash run that quietly examined a fraction of what the user asked for
 * reports fewer clashes with nothing on screen to say so.
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

/**
 * The selector stored for a side whose definition is its FILTER.
 *
 * A rule always stores a type selector (every reader, validator and older app
 * version expects one), so a filtered side needs a stand-in. It is
 * "match nothing", not `*`: if the filter is ever lost — cleared in the
 * editor, unreadable in storage, opened by a build that does not know about
 * filters — the side then matches NOTHING and the run says so loudly
 * ("matched 0 elements", and `classifyRuleCoverage` reports `no-match`),
 * instead of quietly clashing every element in the model against the other
 * side. `!*` is the selector grammar's own spelling of that (`selectors.ts`).
 */
export const CLASH_SET_FILTER_SELECTOR = '!*';

/** The A/B filters of one clash set definition. */
export type ClashSetFilters = { filterA?: ClashSetFilter; filterB?: ClashSetFilter };

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
