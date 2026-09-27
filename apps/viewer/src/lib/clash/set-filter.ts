/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Clash side definitions share the search editor's OR-of-groups model (#5898). */
import { isFilterRule, totalRuleCount, type FilterGroup, type FilterRule } from '@ifc-lite/rules';

/** A group can carry entries written by a newer build; runs must refuse them. */
export interface ClashFilterGroup extends FilterGroup {
  unreadableRules?: unknown[];
  unreadableGroup?: unknown;
}

export type ClashSetFilter = ClashFilterGroup[];
export type ClashSetFilters = { filterA?: ClashSetFilter; filterB?: ClashSetFilter };

/** The evaluator stops at its limit, so ask for one more and refuse overflow. */
export const CLASH_SET_FILTER_LIMIT = 250_000;

export function unreadableRuleCount(filter: ClashSetFilter | undefined): number {
  return filter?.reduce(
    (sum, group) => sum + (group.unreadableRules?.length ?? 0) + ('unreadableGroup' in group ? 1 : 0),
    0,
  ) ?? 0;
}

/** A rule-less side falls back to its selector; an unreadable side refuses. */
export function activeClashSetFilter(filter: ClashSetFilter | undefined): ClashSetFilter | undefined {
  return filter && (totalRuleCount(filter) > 0 || unreadableRuleCount(filter) > 0) ? filter : undefined;
}

export function describeClashSetFilter(filter: ClashSetFilter): string {
  const n = totalRuleCount(filter);
  const count = `${n} rule${n === 1 ? '' : 's'}`;
  const activeGroups = filter.filter((group) => group.rules.length > 0).length;
  const base = activeGroups > 1
    ? `${count} · ${activeGroups} groups (OR)`
    : n > 1 ? `${count} · ${filter.find((group) => group.rules.length > 0)?.combinator ?? 'AND'}` : count;
  const unreadable = unreadableRuleCount(filter);
  return unreadable > 0 ? `${base} · ${unreadable} unreadable` : base;
}

function unreadableGroup(raw: unknown): ClashFilterGroup {
  return { combinator: 'AND', rules: [], unreadableGroup: raw };
}

function parseGroup(raw: unknown, legacy: boolean): ClashFilterGroup {
  if (!raw || typeof raw !== 'object') return unreadableGroup(raw);
  const value = raw as {
    combinator?: unknown;
    rules?: unknown;
    unreadableRules?: unknown;
    unreadableGroup?: unknown;
  };
  // A previously parked whole group remains opaque for a later build.
  if ('unreadableGroup' in value) return unreadableGroup(value.unreadableGroup);
  if (!Array.isArray(value.rules)) return unreadableGroup(raw);
  // A newer writer may have parked rules in a shape this build cannot decode.
  // Ignoring that field would let the readable rules run as a broader set.
  if ('unreadableRules' in value && !Array.isArray(value.unreadableRules)) return unreadableGroup(raw);
  if (!legacy && value.combinator !== 'AND' && value.combinator !== 'OR') return unreadableGroup(raw);
  const candidates = [
    ...value.rules,
    ...(Array.isArray(value.unreadableRules) ? value.unreadableRules : []),
  ];
  const rules: FilterRule[] = [];
  const unreadableRules: unknown[] = [];
  for (const candidate of candidates) {
    (isFilterRule(candidate) ? rules : unreadableRules).push(candidate);
  }
  return {
    combinator: value.combinator === 'OR' ? 'OR' : 'AND',
    rules,
    ...(unreadableRules.length > 0 ? { unreadableRules } : {}),
  };
}

/** Legacy `{ combinator, rules }` values become one group; new arrays retain all groups. */
export function parseClashSetFilter(raw: unknown): ClashSetFilter | undefined {
  if (Array.isArray(raw)) {
    const groups = raw.map((group) => parseGroup(group, false));
    return activeClashSetFilter(groups);
  }
  // Only an absent value means "use the selector". Any saved value whose
  // shape this build cannot read remains present and refuses the run.
  if (raw === null || raw === undefined) return undefined;
  return activeClashSetFilter([parseGroup(raw, true)]);
}

export function parseClashSetFilters(raw: unknown): ClashSetFilters {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as { filterA?: unknown; filterB?: unknown };
  const filterA = parseClashSetFilter(value.filterA);
  const filterB = parseClashSetFilter(value.filterB);
  return { ...(filterA ? { filterA } : {}), ...(filterB ? { filterB } : {}) };
}

/** A filtered side's selector is fail-closed if an old app drops its filter. */
export const CLASH_SET_FILTER_SELECTOR = '!*';
