/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FilterGroup` — one AND-combined (or OR-combined, per its own
 * `combinator`) list of `FilterRule`s. A `SearchFilterStateValue` (and a
 * saved filter, #4904) carries an ARRAY of these; groups themselves are
 * always OR'd together, mirroring the selector grammar's `+` union
 * (`IfcSlab, material=concrete + IfcDoor` → two groups).
 *
 * Kept in its own file (not folded into `filter-rules.ts`, already near the
 * module-size cap) so both the evaluator and the serialization layer can
 * import it without pulling in the whole rule taxonomy's JSON guards.
 */

import { isFilterRule, type Combinator, type FilterRule } from './filter-rules.js';

export interface FilterGroup {
  rules: FilterRule[];
  combinator: Combinator;
}

/** A fresh, empty AND group — what a brand-new filter (or a brand-new
 *  group added in the builder) starts from. */
export function emptyFilterGroup(): FilterGroup {
  return { rules: [], combinator: 'AND' };
}

export function isFilterGroup(value: unknown): value is FilterGroup {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as { rules?: unknown; combinator?: unknown };
  return (
    Array.isArray(g.rules) &&
    g.rules.every(isFilterRule) &&
    (g.combinator === 'AND' || g.combinator === 'OR')
  );
}

/**
 * Render `groups` back as selector-ish text — NOT a full inverse of
 * `parseSelector`/`selectorToFilterRules` (most rule kinds have no single
 * canonical spelling; a regex `Name` rule and a typed-in `contains` rule
 * both become `Rule.name`, and only one of those round-trips through text).
 * What this DOES round-trip exactly is the shape the selector's own union
 * syntax cares about: class names (`IfcWall`, `IfcDoor`, …) and GlobalIds,
 * `+`-joined across groups. Used by the Selector field to echo back what
 * the CURRENT filter state reads as, so adding a second group in the
 * builder is visible as a second `+`-joined clause without leaving the
 * builder (#4904).
 *
 * All-or-nothing: an empty group, or a group whose rules do not reduce to
 * exactly ONE renderable clause, makes the WHOLE echo `''` rather than a
 * partial rendering — review (PR #4987) caught that joining per-group
 * fragments with `+` regardless produced text that read as a DIFFERENT
 * query than what evaluation actually runs: an empty group left a
 * dangling ` + `, and several `ifcType`/`globalId` rules AND'd within one
 * group rendered as comma-separated union terms (selector-text unions use
 * `,` to ADD classes, not narrow them), so a two-rule AND group echoed as
 * something the evaluator would read as broader than what it actually
 * matches. Silently showing a narrower or broader query back to the user
 * is the same "matched nothing, said nothing" defect class #4091 exists to
 * avoid, so this omits the echo entirely rather than guess.
 */
export function groupsToSelectorText(groups: readonly FilterGroup[]): string {
  const clauses: string[] = [];
  for (const group of groups) {
    if (group.rules.length === 0) continue;
    if (group.rules.length !== 1) return '';
    const clause = ruleToSelectorClause(group.rules[0]);
    if (clause === null) return '';
    clauses.push(clause);
  }
  return clauses.join(' + ');
}

function ruleToSelectorClause(rule: FilterRule): string | null {
  switch (rule.kind) {
    case 'ifcType':
      if (!Array.isArray(rule.values) || rule.values.length === 0) return null;
      return rule.values.map((v) => (rule.op === 'notIn' ? `! ${v}` : v)).join(', ');
    case 'globalId':
      if (!Array.isArray(rule.values) || rule.values.length === 0) return null;
      return rule.values.map((v) => (rule.op === 'notIn' ? `! ${v}` : v)).join(', ');
    default:
      // Every other rule kind has no single canonical selector spelling —
      // omitted rather than guessed. See the module doc above.
      return null;
  }
}

/** The rules of `groups[activeIndex]`, clamped into range — what the
 *  builder's active-group actions (`addFilterRule` etc., `searchSlice.
 *  filterGroups.ts`) operate on. Callers outside the store (HierarchyPanel's
 *  upsert-by-kind) read this instead of reimplementing the clamp. */
export function activeGroupRules(groups: readonly FilterGroup[], activeIndex: number): FilterRule[] {
  if (groups.length === 0) return [];
  const i = Math.max(0, Math.min(activeIndex, groups.length - 1));
  return groups[i]?.rules ?? [];
}

/** Total rule count across every group — what "empty filter" checks and rule
 *  count badges read, since a `groups.length === 1` filter with zero rules
 *  in that one group must still read as empty. */
export function totalRuleCount(groups: readonly FilterGroup[]): number {
  let n = 0;
  for (const g of groups) n += g.rules.length;
  return n;
}

/**
 * Parse a persisted `groups` array, refusing (returning `null`) the WHOLE
 * query rather than silently dropping a group this build cannot read. A
 * saved filter with an unreadable group is exactly the "matched nothing,
 * said nothing" defect class #4091 exists to avoid — narrowing it to the
 * readable groups would change which elements a `+` union matches without
 * telling anyone.
 */
export function parseFilterGroups(raw: unknown): FilterGroup[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const groups: FilterGroup[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const g = entry as { rules?: unknown; combinator?: unknown };
    if (!Array.isArray(g.rules)) return null;
    // Every rule in a persisted group must parse — a group carrying even
    // one rule this build cannot read is not "mostly readable", it is a
    // different query, so the whole thing is refused (see module doc).
    if (!g.rules.every(isFilterRule)) return null;
    // A missing/corrupted combinator must refuse too, not default to AND —
    // review (PR #4987): silently coercing a dropped/garbled `OR` into
    // `AND` changes which elements the group matches without telling
    // anyone, the exact defect class this whole function exists to avoid.
    if (g.combinator !== 'AND' && g.combinator !== 'OR') return null;
    groups.push({ rules: g.rules as FilterRule[], combinator: g.combinator });
  }
  return groups;
}
