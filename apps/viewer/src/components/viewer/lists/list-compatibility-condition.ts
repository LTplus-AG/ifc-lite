/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConditionOperator, PropertyCondition, UnreadableListCondition } from '@ifc-lite/lists';

export type ConditionSource = PropertyCondition['source'];
const EDITABLE_SOURCES: readonly ConditionSource[] = [
  'attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone',
];

export function operatorsFor(source: ConditionSource): ConditionOperator[] {
  switch (source) {
    case 'quantity': return ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'exists'];
    case 'material':
    case 'classification': return ['contains', 'equals', 'notEquals', 'exists'];
    default: return ['equals', 'notEquals', 'contains', 'exists'];
  }
}

/** Malformed persisted rows must never enter a native select with no option. */
export function isEditableCondition(row: UnreadableListCondition): row is Exclude<UnreadableListCondition, { reason: 'invalid-condition' }> {
  if (row.reason === 'invalid-condition' || row.reason === 'invalid-value') return false;
  if (typeof row.condition !== 'object' || row.condition === null || Array.isArray(row.condition)) return false;
  const condition = row.condition as unknown as Record<string, unknown>;
  if (typeof condition.source !== 'string' || typeof condition.propertyName !== 'string'
    || typeof condition.operator !== 'string' || !['string', 'number', 'boolean'].includes(typeof condition.value)
    || (condition.psetName !== undefined && typeof condition.psetName !== 'string')
    || (condition.inherit !== undefined && condition.inherit !== 'type' && condition.inherit !== 'aggregation')) return false;
  const source = condition.source as ConditionSource;
  return EDITABLE_SOURCES.includes(source) && operatorsFor(source).includes(condition.operator as ConditionOperator);
}

export function describeUneditable(row: UnreadableListCondition, malformedLabel: string): string {
  if (row.reason === 'invalid-condition' || typeof row.condition !== 'object' || row.condition === null) return malformedLabel;
  const fields = row.condition as unknown as Record<string, unknown>;
  return `${String(fields.source ?? '?')}: ${String(fields.propertyName ?? '?')} ${String(fields.operator ?? '?')} (${row.reason})`;
}
