/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Decode saved List conditions into Rules groups (#5894, #6190). A property
 * comparison becomes a canonical `property` rule; every other Lists predicate
 * becomes a `listCondition` rule, which the Lists engine still answers, so no
 * saved predicate changes the rows it keeps. Only data no build can evaluate
 * (malformed members, an unknown operator or source, a rule this build cannot
 * read) stays in `unreadableConditions`, visible and removable. */
import {
  LIST_CONDITION_OPERATORS, LIST_CONDITION_SOURCES, Rule, isFilterRule, legacyListOperatorToFilterRule,
  type FilterGroup, type FilterRule,
} from '@ifc-lite/rules';
import { isNamePattern } from './name-pattern.js';
import type { ListDefinition, PropertyCondition, UnreadableListCondition } from './types.js';

type MigrationResult = { groups: FilterGroup[]; unreadableConditions: UnreadableListCondition[] };
type Converted = { rule: FilterRule } | { unreadable: UnreadableListCondition };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COLUMN_SOURCES = new Set(['attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone', 'geometry']);
const UNREADABLE_REASONS = new Set(['unsupported-source', 'unsupported-attribute', 'name-pattern', 'inherit', 'operator', 'invalid-value', 'mixed-groups']);
const OPERATORS: ReadonlySet<string> = new Set(LIST_CONDITION_OPERATORS);
const SOURCES: ReadonlySet<string> = new Set(LIST_CONDITION_SOURCES);

/** Saved JSON crosses a trust boundary before the typed Lists API sees it.
 * Group CONTENTS are checked by `migrateLegacyListDefinition`, which keeps an
 * unreadable rule visible instead of rejecting the whole list. */
export function isSavedListShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string'
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.entityTypes) || !value.entityTypes.every((item) => typeof item === 'number' && Number.isInteger(item))
    || !Array.isArray(value.columns) || !value.columns.every((column) => isRecord(column)
      && typeof column.id === 'string' && typeof column.source === 'string' && COLUMN_SOURCES.has(column.source)
      && typeof column.propertyName === 'string')) return false;
  if (value.groups !== undefined && !Array.isArray(value.groups)) return false;
  if (value.unreadableConditions !== undefined && (!Array.isArray(value.unreadableConditions)
    || !value.unreadableConditions.every((row) => isRecord(row) && (
      (row.reason === 'invalid-condition' && 'condition' in row)
      || (typeof row.reason === 'string' && UNREADABLE_REASONS.has(row.reason) && isStoredCondition(row.condition))
    )))) return false;
  if (value.expressIdsByModel !== undefined && (!isRecord(value.expressIdsByModel)
    || !Object.values(value.expressIdsByModel).every((ids) => Array.isArray(ids)
      && ids.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)))) return false;
  if (value.grouping !== undefined && (!isRecord(value.grouping)
    || typeof value.grouping.columnId !== 'string'
    || !Array.isArray(value.grouping.sumColumnIds)
    || !value.grouping.sumColumnIds.every((id) => typeof id === 'string')
    || (value.grouping.columnIds !== undefined && (!Array.isArray(value.grouping.columnIds)
      || !value.grouping.columnIds.every((id) => typeof id === 'string')))
    || (value.grouping.view !== undefined && value.grouping.view !== 'nested' && value.grouping.view !== 'schedule'))) return false;
  return true;
}

function isStoredCondition(value: unknown): value is PropertyCondition {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.source === 'string' && typeof row.propertyName === 'string'
    && typeof row.operator === 'string'
    && (row.psetName === undefined || typeof row.psetName === 'string')
    && (row.inherit === undefined || row.inherit === 'type' || row.inherit === 'aggregation');
}

/** One saved condition as the Rules rule that keeps its rows, or why it has none. */
function convertCondition(condition: unknown): Converted {
  if (!isStoredCondition(condition)) return { unreadable: { condition, reason: 'invalid-condition' } };
  const { source, psetName, propertyName, operator, value, inherit } = condition;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return { unreadable: { condition, reason: 'invalid-value' } };
  }
  if (!OPERATORS.has(operator)) return { unreadable: { condition, reason: 'operator' } };
  if (!SOURCES.has(source)) return { unreadable: { condition, reason: 'unsupported-source' } };
  // A plain property comparison has a canonical form with the v1 first-match contract (#5894).
  if (source === 'property' && !inherit && !isNamePattern(psetName ?? '') && !isNamePattern(propertyName)) {
    const converted = legacyListOperatorToFilterRule(operator, {
      kind: 'property', setName: psetName ?? '', propertyName,
      nameCaseMode: 'exact', legacyListFirst: true, op: 'eq', value: String(value),
    });
    if (converted.status === 'readable') return { rule: converted.value };
  }
  return { rule: Rule.listCondition({
    source, propertyName, operator, value,
    ...(psetName !== undefined ? { psetName } : {}), ...(inherit ? { inherit } : {}),
  }) };
}

export function migrateLegacyListConditions(conditions: readonly unknown[]): MigrationResult {
  const rules: FilterRule[] = [];
  const unreadableConditions: UnreadableListCondition[] = [];
  for (const condition of conditions) {
    const converted = convertCondition(condition);
    if ('rule' in converted) rules.push(converted.rule);
    else unreadableConditions.push(converted.unreadable);
  }
  return { groups: conjoin([], rules), unreadableConditions };
}

/** Groups OR; saved flat conditions narrow every one. AND them into each
 * group, splitting an OR group into one AND group per rule, so
 * `(a OR b) AND c` is kept as `(a AND c) OR (b AND c)`. */
function conjoin(groups: readonly FilterGroup[], rules: readonly FilterRule[]): FilterGroup[] {
  if (rules.length === 0) return [...groups];
  const active = groups.filter((group) => group.rules.length > 0);
  if (active.length === 0) return [{ combinator: 'AND', rules: [...rules] }];
  return active.flatMap((group): FilterGroup[] => group.combinator === 'AND' || group.rules.length === 1
    ? [{ combinator: 'AND', rules: [...group.rules, ...rules] }]
    : group.rules.map((rule) => ({ combinator: 'AND', rules: [rule, ...rules] })));
}

/** Rules this build cannot read leave their group as visible, removable rows
 * rather than making the whole saved list disappear. */
function readGroups(raw: readonly unknown[]): MigrationResult {
  const groups: FilterGroup[] = [];
  const unreadableConditions: UnreadableListCondition[] = [];
  for (const group of raw) {
    if (!isRecord(group) || !Array.isArray(group.rules) || (group.combinator !== 'AND' && group.combinator !== 'OR')) {
      unreadableConditions.push({ condition: group, reason: 'invalid-condition' });
      continue;
    }
    const rules: FilterRule[] = [];
    for (const rule of group.rules) {
      if (isFilterRule(rule)) rules.push(rule);
      else unreadableConditions.push({ condition: rule, reason: 'invalid-condition' });
    }
    groups.push({ rules, combinator: group.combinator });
  }
  return { groups, unreadableConditions };
}

/** Normalize a saved definition before it enters the public Lists API:
 * v1 `conditions` and earlier provider-only rows become Rules, idempotently. */
export function migrateLegacyListDefinition(definition: unknown): ListDefinition {
  if (!isSavedListShape(definition)) throw new Error('Invalid saved list definition');
  const { conditions, groups: rawGroups, unreadableConditions: saved, ...rest } = definition as Omit<ListDefinition, 'groups'> & {
    groups?: unknown[]; conditions?: unknown;
  };
  const read = readGroups(rawGroups ?? []);
  const rules: FilterRule[] = [];
  const unreadable = [...read.unreadableConditions];
  // Rows saved while the scoped compatibility editor existed: convertible ones become rules.
  for (const row of saved ?? []) {
    const converted = row.reason === 'invalid-condition' ? null : convertCondition(row.condition);
    if (converted && 'rule' in converted) rules.push(converted.rule);
    else unreadable.push(row);
  }
  const legacy = conditions === undefined ? [] : Array.isArray(conditions) ? conditions : [conditions];
  for (const condition of legacy) {
    const converted = convertCondition(condition);
    if ('rule' in converted) rules.push(converted.rule);
    else unreadable.push(converted.unreadable);
  }
  return {
    ...rest, groups: conjoin(read.groups, rules),
    ...(unreadable.length > 0 || saved !== undefined ? { unreadableConditions: unreadable } : {}),
  } as ListDefinition;
}
