/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConditionOperator, PropertyCondition, UnreadableListCondition } from '@ifc-lite/lists';

export type ConditionSource = PropertyCondition['source'];
const EDITABLE_SOURCES: readonly ConditionSource[] = [
  'attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone',
];
const EDITABLE_REASONS = ['unsupported-source', 'unsupported-attribute', 'name-pattern', 'inherit', 'operator'] as const;

export function operatorsFor(source: ConditionSource): ConditionOperator[] {
  switch (source) {
    case 'quantity': return ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'exists'];
    case 'material':
    case 'classification': return ['contains', 'equals', 'notEquals', 'exists'];
    default: return ['equals', 'notEquals', 'contains', 'exists'];
  }
}

/** Malformed persisted rows must never enter a native select with no option. */
export function isEditableCondition(row: unknown): row is Exclude<UnreadableListCondition, { reason: 'invalid-condition' }> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
  const saved = row as Record<string, unknown>;
  if (!EDITABLE_REASONS.some((reason) => reason === saved.reason)) return false;
  if (typeof saved.condition !== 'object' || saved.condition === null || Array.isArray(saved.condition)) return false;
  const condition = saved.condition as Record<string, unknown>;
  if (typeof condition.source !== 'string' || typeof condition.propertyName !== 'string'
    || typeof condition.operator !== 'string' || !['string', 'number', 'boolean'].includes(typeof condition.value)
    || (condition.psetName !== undefined && typeof condition.psetName !== 'string')
    || (condition.inherit !== undefined && condition.inherit !== 'type' && condition.inherit !== 'aggregation')) return false;
  const source = condition.source as ConditionSource;
  return EDITABLE_SOURCES.includes(source) && operatorsFor(source).includes(condition.operator as ConditionOperator);
}

export function describeUneditable(row: unknown, malformedLabel: string): string {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return malformedLabel;
  const saved = row as Record<string, unknown>;
  if (saved.reason === 'invalid-condition' || typeof saved.condition !== 'object' || saved.condition === null) return malformedLabel;
  const fields = saved.condition as Record<string, unknown>;
  return `${String(fields.source ?? '?')}: ${String(fields.propertyName ?? '?')} ${String(fields.operator ?? '?')} (${String(saved.reason)})`;
}
