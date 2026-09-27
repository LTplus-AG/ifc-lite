/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConditionOperator, UnreadableListCondition } from '@ifc-lite/lists';
import { operatorsFor, type ConditionSource } from './list-condition-fields.js';

export type { ConditionSource } from './list-condition-fields.js';
export { operatorsFor } from './list-condition-fields.js';
const EDITABLE_SOURCES: readonly ConditionSource[] = [
  'attribute', 'property', 'quantity', 'material', 'classification', 'spatial', 'model', 'zone',
];
const EXECUTABLE_SOURCES: readonly ConditionSource[] = [...EDITABLE_SOURCES, 'geometry'];
const EDITABLE_REASONS = ['unsupported-source', 'unsupported-attribute', 'name-pattern', 'inherit', 'operator', 'mixed-groups'] as const;
const SCALAR_OPERATORS: readonly ConditionOperator[] = ['equals', 'notEquals', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'];
const MULTI_VALUE_OPERATORS: readonly ConditionOperator[] = ['equals', 'notEquals', 'contains', 'exists'];

/** The provider can execute more persisted conditions than the compatibility editor can author. */
export function isExecutableCondition(row: unknown): row is Exclude<UnreadableListCondition, { reason: 'invalid-condition' }> {
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
  if (!EXECUTABLE_SOURCES.includes(source)) return false;
  const operators = source === 'material' || source === 'classification' ? MULTI_VALUE_OPERATORS : SCALAR_OPERATORS;
  return operators.includes(condition.operator as ConditionOperator);
}

/** Malformed persisted rows must never enter a native select with no option. */
export function isEditableCondition(row: unknown): row is Exclude<UnreadableListCondition, { reason: 'invalid-condition' }> {
  if (!isExecutableCondition(row)) return false;
  return EDITABLE_SOURCES.includes(row.condition.source)
    && operatorsFor(row.condition.source).includes(row.condition.operator);
}

export function describeUneditable(row: unknown, malformedLabel: string): string {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return malformedLabel;
  const saved = row as Record<string, unknown>;
  if (saved.reason === 'invalid-condition' || typeof saved.condition !== 'object' || saved.condition === null) return malformedLabel;
  const fields = saved.condition as Record<string, unknown>;
  return `${String(fields.source ?? '?')}: ${String(fields.propertyName ?? '?')} ${String(fields.operator ?? '?')} (${String(saved.reason)})`;
}
