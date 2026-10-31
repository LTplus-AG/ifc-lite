/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `customGrouping` (#8425): membership in a named group of a user-authored
 * grouping, so a classification authored once ("Structure", "Facade", "MEP")
 * is reused by every feature that takes a `FilterGroup`: search, clash sets,
 * lists, validation, bulk edit, charts.
 *
 * A grouping is an ORDERED list of named members, each a `FilterGroup[]`. An
 * element belongs to the FIRST enabled member it matches and to no other, so
 * the result is an exclusive, one-level classification. This is the viewer
 * Lens's first-match rule, and the viewer feeds its rule-based lenses in as
 * groupings, so a lens legend and a `customGrouping` rule never disagree.
 * Disabled members keep their name defined but have no members; a member
 * action (colour, hide, transparent) is display-only and ignored here.
 *
 * Definitions are host data (`EvaluatorModel.customGroupings`), never read by
 * this package from storage. A rule references its grouping by name with the
 * id as a hint: the id wins when it exists here, otherwise the trimmed,
 * case-folded name must match exactly one definition, so a grouping file
 * imported into another project still resolves. A rule naming a grouping or
 * group that does not exist is UNRESOLVED and matches nothing under either
 * op; `unresolvedCustomGrouping` says which part is missing.
 *
 * Members may themselves use `customGrouping` rules. Evaluation is per
 * element through the host evaluator's own rule matcher, so mutation
 * overlays and model context apply unchanged; a grouping that reaches itself
 * again while being evaluated throws instead of recursing.
 */

import type { FilterGroup } from './filter-groups.js';
import type { SetOp } from './filter-operator-types.js';
import { normalizeModelTagName as nameKey } from './model-tag.js';
import { assertListConditionsAnswerable, type ListConditionMatcher } from './filter-list-condition.js';

export interface CustomGroupingRef {
  /** Hint only: preferred when a definition with this id exists. */
  id?: string;
  name: string;
}

export interface CustomGroupingRule {
  kind: 'customGrouping';
  grouping: CustomGroupingRef;
  /** `in`: the element's group is one of `values`. `notIn`: it is not, ungrouped included. */
  op: SetOp;
  /** Group (member) names. */
  values: string[];
}

export interface CustomGroupingMember {
  name: string;
  enabled: boolean;
  /** `null` when the member's filter could not be read: the name stays defined, nothing matches it. */
  filter: readonly FilterGroup[] | null;
}

export interface CustomGroupingDefinition {
  id: string;
  name: string;
  /** In precedence order: the first enabled member an element matches is its group. */
  members: readonly CustomGroupingMember[];
  /** Restricts the grouping to a population; absent = every element. */
  inScope?: (modelId: string, expressId: number) => boolean;
}

/** Does `expressId` match `filter` (OR across groups)? Supplied by the evaluator. */
export type CustomGroupingFilterMatcher = (filter: readonly FilterGroup[]) => boolean;

export function customGroupingRule(grouping: CustomGroupingRef, op: SetOp, values: string[]): CustomGroupingRule {
  return { kind: 'customGrouping', grouping: grouping.id ? { id: grouping.id, name: grouping.name } : { name: grouping.name }, op, values };
}

export function isCustomGroupingRule(value: unknown): value is CustomGroupingRule {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const g = r.grouping as Record<string, unknown> | null | undefined;
  return r.kind === 'customGrouping' && (r.op === 'in' || r.op === 'notIn')
    && Array.isArray(r.values) && r.values.every((v) => typeof v === 'string')
    && typeof g === 'object' && g !== null && typeof g.name === 'string'
    && (g.id === undefined || typeof g.id === 'string');
}

/** The definition `ref` names: by id when present here, else by a unique name. */
export function resolveCustomGrouping(
  ref: CustomGroupingRef,
  definitions: readonly CustomGroupingDefinition[],
): CustomGroupingDefinition | undefined {
  const byId = ref.id ? definitions.find((d) => d.id === ref.id) : undefined;
  if (byId) return byId;
  const key = nameKey(ref.name);
  const named = definitions.filter((d) => nameKey(d.name) === key);
  return named.length === 1 ? named[0] : undefined;
}

/** What makes `rule` unresolved: the whole grouping, the listed group names, or nothing (`null`). */
export function unresolvedCustomGrouping(
  rule: Pick<CustomGroupingRule, 'grouping' | 'values'>,
  definitions: readonly CustomGroupingDefinition[],
): { grouping: true } | { groups: string[] } | null {
  const definition = resolveCustomGrouping(rule.grouping, definitions);
  if (!definition) return { grouping: true };
  const defined = new Set(definition.members.map((m) => nameKey(m.name)));
  const groups = rule.values.filter((v) => !defined.has(nameKey(v)));
  return groups.length > 0 ? { groups } : null;
}

/** The group `expressId` belongs to in `definition` (the first matching enabled member's name), or `undefined`. */
export function customGroupOf(
  definition: CustomGroupingDefinition,
  modelId: string,
  expressId: number,
  matches: CustomGroupingFilterMatcher,
): string | undefined {
  if (definition.inScope && !definition.inScope(modelId, expressId)) return undefined;
  for (const member of definition.members) {
    if (member.enabled && member.filter?.length && matches(member.filter)) return member.name;
  }
  return undefined;
}

/**
 * Answer one `customGrouping` rule for one element. `active` holds the ids of
 * groupings being evaluated further up this element's stack (cycle guard).
 */
export function matchCustomGroupingRule(
  rule: CustomGroupingRule,
  definitions: readonly CustomGroupingDefinition[] | undefined,
  modelId: string,
  expressId: number,
  matches: CustomGroupingFilterMatcher,
  active: Set<string>,
): boolean {
  if (!definitions) throw new Error(missingMessage(rule, modelId));
  if (unresolvedCustomGrouping(rule, definitions)) return false;
  const definition = resolveCustomGrouping(rule.grouping, definitions)!;
  if (active.has(definition.id)) {
    throw new Error(`Custom grouping "${definition.name}" refers to itself through its own groups. Remove the circular reference.`);
  }
  active.add(definition.id);
  let group: string | undefined;
  try {
    group = customGroupOf(definition, modelId, expressId, matches);
  } finally {
    active.delete(definition.id);
  }
  const hit = group !== undefined && rule.values.some((v) => nameKey(v) === nameKey(group));
  return rule.op === 'in' ? hit : !hit;
}

function missingMessage(rule: Pick<CustomGroupingRule, 'grouping'>, modelId: string): string {
  return `The custom grouping "${rule.grouping.name}" needs the host's grouping definitions for model "${modelId}"; nothing was run.`;
}

/** Refuse up front, like `listCondition`, a run with a `customGrouping` rule on a model without definitions. */
export function assertCustomGroupingsAnswerable(
  rules: readonly { kind: string }[],
  models: readonly { id: string; customGroupings?: readonly CustomGroupingDefinition[]; store?: unknown }[],
): void {
  const rule = rules.find((r): r is CustomGroupingRule => r.kind === 'customGrouping');
  if (!rule) return;
  const model = models.find((m) => m.store !== null && !m.customGroupings);
  if (model) throw new Error(missingMessage(rule, model.id));
}

/** Every host-read rule kind's up-front check, so each evaluator entry calls one function. */
export function assertHostRulesAnswerable(
  rules: readonly { kind: string }[],
  models: readonly { id: string; listConditions?: ListConditionMatcher; customGroupings?: readonly CustomGroupingDefinition[]; store?: unknown }[],
): void {
  assertListConditionsAnswerable(rules, models);
  assertCustomGroupingsAnswerable(rules, models);
}
