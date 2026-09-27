/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Decode v1 saved List conditions without claiming that unsupported sources
 * have been converted. Unreadable rows remain explicit and active. */
import { isFilterGroup, legacyListOperatorToFilterRule, type FilterGroup, type FilterRule } from '@ifc-lite/rules';
import { isNamePattern } from './name-pattern.js';
import type { ListDefinition, PropertyCondition, UnreadableListCondition } from './types.js';

type MigrationResult = { groups: FilterGroup[]; unreadableConditions: UnreadableListCondition[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COLUMN_SOURCES = new Set(['attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone', 'geometry']);
const UNREADABLE_REASONS = new Set(['unsupported-source', 'unsupported-attribute', 'name-pattern', 'inherit', 'operator', 'invalid-value', 'mixed-groups']);

/** Saved JSON crosses a trust boundary before the typed Lists API sees it. */
export function isSavedListShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string'
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.entityTypes) || !value.entityTypes.every((item) => typeof item === 'number' && Number.isInteger(item))
    || !Array.isArray(value.columns) || !value.columns.every((column) => isRecord(column)
      && typeof column.id === 'string' && typeof column.source === 'string' && COLUMN_SOURCES.has(column.source)
      && typeof column.propertyName === 'string')) return false;
  if (value.groups !== undefined && (!Array.isArray(value.groups) || !value.groups.every(isFilterGroup))) return false;
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

export function migrateLegacyListConditions(conditions: readonly unknown[]): MigrationResult {
  const rules: FilterRule[] = [];
  const unreadableConditions: UnreadableListCondition[] = [];

  for (const condition of conditions) {
    if (!isStoredCondition(condition)) {
      unreadableConditions.push({ condition, reason: 'invalid-condition' });
      continue;
    }
    if (typeof condition.value !== 'string' && typeof condition.value !== 'number' && typeof condition.value !== 'boolean') {
      unreadableConditions.push({ condition, reason: 'invalid-value' });
      continue;
    }
    if (condition.source === 'attribute') {
      // V1's pseudo-attributes (Name, GlobalId, Class, Type, etc.) have
      // distinct source semantics; keep them on the old path until parity is
      // proved for each rather than convert a superficially similar rule.
      unreadableConditions.push({ condition, reason: 'unsupported-attribute' });
      continue;
    }
    if (condition.source === 'property') {
      // Subject inheritance has a separate Rules read path that does not
      // preserve the v1 first-property scalar contract yet.
      if (condition.inherit) {
        unreadableConditions.push({ condition, reason: 'inherit' });
        continue;
      }
      // Rules' regex names have their own syntax; keep v1 `/regex/flags`
      // conditions on the old path until flags and first-match parity land.
      if (isNamePattern(condition.psetName ?? '') || isNamePattern(condition.propertyName)) {
        unreadableConditions.push({ condition, reason: 'name-pattern' });
        continue;
      }
      const converted = legacyListOperatorToFilterRule(condition.operator, {
        kind: 'property', setName: condition.psetName ?? '', propertyName: condition.propertyName,
        nameCaseMode: 'exact', legacyListFirst: true,
        op: 'eq', value: String(condition.value),
      });
      if (converted.status === 'readable') rules.push(converted.value);
      else unreadableConditions.push({ condition, reason: 'operator' });
      continue;
    }
    unreadableConditions.push({ condition, reason: 'unsupported-source' });
  }

  return {
    groups: rules.length > 0 ? [{ rules, combinator: 'AND' }] : [],
    unreadableConditions,
  };
}

/** Normalize a saved v1 definition before it enters the public Lists API. */
export function migrateLegacyListDefinition(
  definition: unknown,
): ListDefinition {
  if (!isSavedListShape(definition)) throw new Error('Invalid saved list definition');
  const { conditions, ...canonical } = definition as Omit<ListDefinition, 'groups'> & {
    groups?: ListDefinition['groups']; conditions?: unknown;
  };
  const existing = canonical.unreadableConditions ?? [];
  const legacy = conditions === undefined ? [] : Array.isArray(conditions) ? conditions : [conditions];
  if (canonical.groups !== undefined) {
    if (legacy.length === 0) return canonical as ListDefinition;
    // Groups are ORed. Keep mixed v1 predicates in the provider candidate pass,
    // which ANDs them with the existing groups rather than widening the list.
    const mixed: UnreadableListCondition[] = legacy.map((condition) => {
      if (!isStoredCondition(condition)) return { condition, reason: 'invalid-condition' };
      if (!['string', 'number', 'boolean'].includes(typeof condition.value)) {
        return { condition, reason: 'invalid-value' };
      }
      return { condition, reason: 'mixed-groups' };
    });
    return { ...canonical, unreadableConditions: [...existing, ...mixed] } as ListDefinition;
  }
  const migrated = migrateLegacyListConditions(
    legacy,
  );
  const unreadableConditions = [...existing, ...migrated.unreadableConditions];
  return { ...canonical, groups: migrated.groups,
    ...(unreadableConditions.length ? { unreadableConditions } : {}) };
}
