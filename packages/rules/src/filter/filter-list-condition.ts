/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `listCondition` (#6190): a Lists value predicate carried inside a Rules
 * `FilterGroup`, as an explicit adapter rather than a canonical kind.
 *
 * The fields are the saved Lists condition, verbatim: `source`, `psetName`
 * (a pset/qto name, or the durable zone-SET id for `zone`), `propertyName`
 * (an attribute/property/quantity name, the spatial level for `spatial`, the
 * zone display mode for `zone`, the axis for `geometry`), `operator`, `value`
 * and `inherit`. Their meaning is the Lists engine's and nothing else's:
 * this package never reads the value itself. The host supplies a
 * {@link ListConditionMatcher} on the evaluator model (`@ifc-lite/lists`'
 * `listConditionMatcher(provider)`), so one implementation answers the
 * predicate whether it runs as a list scope or inside an OR group.
 *
 * Why not canonical kinds: the canonical readers differ from the Lists ones
 * on purpose. `material` also matches Categories and skips layer labels,
 * `storey` hops through a containing space, `model` compares a durable
 * source fingerprint rather than the file name, `attribute` rejects
 * `GlobalId`, and property inheritance merges per property. Converting a
 * saved Lists predicate to one of them would change which rows it keeps.
 * Zones and world coordinates are viewer data the IFC store does not hold.
 */

export const LIST_CONDITION_SOURCES = [
  'attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone', 'geometry',
] as const;
export type ListConditionSource = (typeof LIST_CONDITION_SOURCES)[number];

export const LIST_CONDITION_OPERATORS = [
  'equals', 'notEquals', 'contains', 'gt', 'lt', 'gte', 'lte', 'exists',
] as const;
export type ListConditionOperator = (typeof LIST_CONDITION_OPERATORS)[number];

export interface ListConditionRule {
  kind: 'listCondition';
  source: ListConditionSource;
  /** Pset / qto name; the durable zone-SET id for `zone`. */
  psetName?: string;
  /** Attribute, property or quantity name; spatial level; zone display mode; axis. */
  propertyName: string;
  operator: ListConditionOperator;
  value: string | number | boolean;
  /** property / quantity only (#5433). */
  inherit?: 'type' | 'aggregation';
}

/** Answers one `listCondition` rule for one element of the model it is attached to. */
export type ListConditionMatcher = (expressId: number, rule: ListConditionRule) => boolean;

const SOURCES: ReadonlySet<unknown> = new Set(LIST_CONDITION_SOURCES);
const OPERATORS: ReadonlySet<unknown> = new Set(LIST_CONDITION_OPERATORS);

/** Structural guard: every field the Lists engine reads has the type it reads. */
export function isListConditionRule(value: unknown): value is ListConditionRule {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return r.kind === 'listCondition' && SOURCES.has(r.source) && OPERATORS.has(r.operator)
    && typeof r.propertyName === 'string'
    && (r.psetName === undefined || typeof r.psetName === 'string')
    && (typeof r.value === 'string' || typeof r.value === 'number' || typeof r.value === 'boolean')
    && (r.inherit === undefined || r.inherit === 'type' || r.inherit === 'aggregation');
}

export function listConditionRule(condition: Omit<ListConditionRule, 'kind'>): ListConditionRule {
  return { kind: 'listCondition', ...condition };
}

/** Refuse, before any element is read, a run whose rules hold a `listCondition`
 * but whose model has no matcher. Checked up front rather than when the rule is
 * reached: a cheaper failing rule earlier in an AND group would otherwise
 * short-circuit past it, and the run would return no rows instead of saying why. */
export function assertListConditionsAnswerable(
  rules: readonly { kind: string }[],
  models: readonly { id: string; listConditions?: ListConditionMatcher; store?: unknown }[],
): void {
  const rule = rules.find((r): r is ListConditionRule => r.kind === 'listCondition');
  if (!rule) return;
  const model = models.find((m) => m.store !== null && !m.listConditions);
  if (model) {
    throw new Error(`A Lists ${rule.source} condition needs the Lists data provider for model "${model.id}"; run it through a list.`);
  }
}

/** A model without a matcher cannot answer the predicate; saying so beats matching nothing. */
export function matchListConditionRule(
  rule: ListConditionRule,
  expressId: number,
  matcher: ListConditionMatcher | undefined,
): boolean {
  if (!matcher) {
    throw new Error(`A Lists ${rule.source} condition needs the Lists data provider; run it through a list.`);
  }
  return matcher(expressId, rule);
}
