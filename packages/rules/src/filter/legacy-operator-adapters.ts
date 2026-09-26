/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure, total operator conversion for persisted Lens, List and Bulk filters (#5892).
 * Callers supply the target field as a rule template; the adapter changes only
 * the comparison, so a missing field or unknown saved operator is never lost
 * through an unrelated source conversion. */
import type { ConditionOperator } from '@ifc-lite/lists';
import type { FilterOperator, PropertyValue } from '@ifc-lite/mutations';
import type { AttributeRule, PropertyRule, ValueComparison, ValueOp } from './filter-rules.js';

type ValueRule = AttributeRule | PropertyRule;
type Vocabulary = 'lens' | 'lists' | 'bulk';

export type LegacyOperatorResult<T> =
  | { status: 'readable'; value: T }
  | { status: 'unreadable'; vocabulary: Vocabulary; operator: string };

const LENS_OPS = {
  equals: 'eq', contains: 'contains', exists: 'isNotNull', ne: 'ne',
  gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
} as const satisfies Record<string, ValueOp>;

/** Operators stored in v1 Lens JSON. Kept private so rules has no Lens package edge. */
type PersistedLensOperator = keyof typeof LENS_OPS;

const LIST_OPS = {
  equals: 'eq', notEquals: 'ne', contains: 'contains', exists: 'isNonEmpty',
  gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
} as const satisfies Record<ConditionOperator, ValueOp>;

const BULK_OPS = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte',
  CONTAINS: 'contains', STARTS_WITH: 'startsWith', ENDS_WITH: 'endsWith',
  IS_NULL: 'isNull', IS_NOT_NULL: 'isNotNull',
} as const satisfies Record<FilterOperator, ValueOp>;

function mapped<T extends ValueOp>(vocabulary: Vocabulary, operator: string, table: Record<string, T>): LegacyOperatorResult<T> {
  return Object.hasOwn(table, operator)
    ? { status: 'readable', value: table[operator]! }
    : { status: 'unreadable', vocabulary, operator };
}

/** Lens equality is exact for text, but folds case for true/false only. */
export function legacyLensOperatorToFilterRule<T extends ValueRule>(
  operator: string,
  template: T,
): LegacyOperatorResult<T> {
  const result = mapped('lens', operator, LENS_OPS);
  if (result.status === 'unreadable') return result;
  const op = operator === 'exists' && template.kind === 'attribute' ? 'isNonEmpty' : result.value;
  return { status: 'readable', value: {
    ...template,
    op,
    comparison: {
      caseMode: operator === 'equals' ? 'lensBoolean' : 'fold',
      numericMode: 'prefix',
    },
  } as T };
}

/** Lists preserve case for text except IFC boolean/logical values; Number() parses comparisons. */
export function legacyListOperatorToFilterRule<T extends ValueRule>(
  operator: string,
  template: T,
): LegacyOperatorResult<T> {
  const result = mapped('lists', operator, LIST_OPS);
  if (result.status === 'unreadable') return result;
  return { status: 'readable', value: {
    ...template,
    op: result.value,
    comparison: {
      caseMode: operator === 'equals' || operator === 'notEquals' ? 'ifcBoolean' : 'fold',
      numericMode: 'strict',
    },
  } as T };
}

function operandType(value: PropertyValue | undefined): 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'array' {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'array';
}

/** Bulk's primitive type dispatch and boolean-string coercion are preserved. */
export function legacyBulkOperatorToFilterRule(
  operator: string,
  template: PropertyRule,
  operand?: PropertyValue,
): LegacyOperatorResult<PropertyRule> {
  const result = mapped('bulk', operator, BULK_OPS);
  if (result.status === 'unreadable') return result;
  return { status: 'readable', value: {
    ...template,
    op: result.value,
    value: operand === null || operand === undefined || Array.isArray(operand) ? '' : String(operand),
    comparison: { typeMode: 'bulk', operandType: operandType(operand) },
  } };
}

function inverse<T extends string>(
  vocabulary: Vocabulary,
  op: ValueOp,
  entries: readonly (readonly [T, ValueOp])[],
): LegacyOperatorResult<T> {
  const match = entries.find(([, canonical]) => canonical === op);
  return match ? { status: 'readable', value: match[0] } : { status: 'unreadable', vocabulary, operator: op };
}

function legacyComparison(
  comparison: ValueComparison | undefined,
  caseMode: ValueComparison['caseMode'],
  numericMode: ValueComparison['numericMode'],
): boolean {
  if (!comparison) return false;
  return comparison.caseMode === caseMode && comparison.numericMode === numericMode
    && comparison.typeMode === undefined && comparison.operandType === undefined;
}

export function filterRuleToLegacyLensOperator(rule: ValueRule): LegacyOperatorResult<PersistedLensOperator> {
  const caseMode = rule.op === 'eq' ? 'lensBoolean' : 'fold';
  if (!legacyComparison(rule.comparison, caseMode, 'prefix')) {
    return { status: 'unreadable', vocabulary: 'lens', operator: rule.op };
  }
  if (rule.op === 'isNonEmpty' && rule.kind === 'attribute') return { status: 'readable', value: 'exists' };
  if (rule.op === 'isNotNull' && rule.kind === 'attribute') {
    return { status: 'unreadable', vocabulary: 'lens', operator: rule.op };
  }
  return inverse('lens', rule.op, Object.entries(LENS_OPS) as [PersistedLensOperator, ValueOp][]);
}

export function filterRuleToLegacyListOperator(rule: ValueRule): LegacyOperatorResult<ConditionOperator> {
  const caseMode = rule.op === 'eq' || rule.op === 'ne' ? 'ifcBoolean' : 'fold';
  if (!legacyComparison(rule.comparison, caseMode, 'strict')) {
    return { status: 'unreadable', vocabulary: 'lists', operator: rule.op };
  }
  return inverse('lists', rule.op, Object.entries(LIST_OPS) as [ConditionOperator, ValueOp][]);
}

export function filterRuleToLegacyBulkOperator(rule: PropertyRule): LegacyOperatorResult<FilterOperator> {
  const comparison = rule.comparison;
  if (comparison?.typeMode !== 'bulk' || comparison.operandType === undefined
    || comparison.caseMode !== undefined || comparison.numericMode !== undefined) {
    return { status: 'unreadable', vocabulary: 'bulk', operator: rule.op };
  }
  return inverse('bulk', rule.op, Object.entries(BULK_OPS) as [FilterOperator, ValueOp][]);
}
