/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON guards for `FilterRule` (saved filters, URL state, presets).
 *
 * Split out of `filter-rules.ts` (which keeps the taxonomy itself — the
 * interfaces and the `Rule` convenience constructors) to stay under the
 * module size cap, the same way `filter-match.ts`/`filter-iteration-source.ts`
 * split out of `filter-evaluate.ts`. Re-exported from `filter-rules.ts` so
 * every existing `import { isFilterRule } from './filter-rules.js'` keeps
 * working unchanged.
 */

import { isModelTagOp } from './model-tag.js';
import { isModelFact } from './filter-model-fact.js';
import { isListConditionRule } from './filter-list-condition.js';
import { isMemberPath } from './subject-read-options.js';
import type { ClassificationOp, FilterRule, NumericOp, SetOp, StringOp, ValueOp } from './filter-rules.js';

const STRING_OPS: ReadonlySet<unknown> = new Set<StringOp>([
  'eq', 'ne', 'contains', 'notContains', 'startsWith', 'matches', 'notMatches',
]);

const VALUE_OPS: ReadonlySet<unknown> = new Set<ValueOp>([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'startsWith', 'endsWith',
  'matches', 'notMatches', 'isSet', 'isNotSet', 'isNonEmpty', 'isNull', 'isNotNull',
]);

const CLASSIFICATION_OPS: ReadonlySet<unknown> = new Set<ClassificationOp>([
  'eq', 'ne', 'contains', 'notContains', 'matches', 'notMatches', 'isSet', 'isNotSet',
]);

const SET_OPS: ReadonlySet<unknown> = new Set<SetOp>(['in', 'notIn']);
const NUMERIC_OPS: ReadonlySet<unknown> = new Set<NumericOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}
function textKind(value: unknown): boolean {
  return value === undefined || value === 'literal' || value === 'regex';
}
function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}
function storeyRefs(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const ref = entry as Record<string, unknown>;
    return typeof ref.modelId === 'string' && finiteNumber(ref.expressId);
  }));
}

/** Validate the JSON boundary before a typed editor or evaluator reads fields (#7554). */
export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (!textKind(r.valueKind)) return false;
  switch (r.kind) {
    case 'modelTag':
      return isModelTagOp(r.op) && strings(r.tagIds);
    case 'model':
    case 'predefinedType':
    case 'globalId':
      return SET_OPS.has(r.op) && strings(r.values);
    case 'ifcType':
      return SET_OPS.has(r.op) && strings(r.values)
        && (r.exactClass === undefined || typeof r.exactClass === 'boolean');
    case 'storey':
      return SET_OPS.has(r.op) && strings(r.values) && storeyRefs(r.refs);
    case 'name':
    case 'material':
    case 'type':
    case 'parent':
      return STRING_OPS.has(r.op) && typeof r.value === 'string';
    case 'group':
      return CLASSIFICATION_OPS.has(r.op) && typeof r.value === 'string'
        && (r.groupClass === undefined || typeof r.groupClass === 'string');
    case 'classification':
      return CLASSIFICATION_OPS.has(r.op) && typeof r.value === 'string'
        && (r.system === undefined || typeof r.system === 'string');
    case 'attribute':
      return typeof r.name === 'string' && VALUE_OPS.has(r.op) && typeof r.value === 'string'
        && validComparison(value);
    case 'property':
      return typeof r.setName === 'string' && typeof r.propertyName === 'string'
        && VALUE_OPS.has(r.op) && typeof r.value === 'string'
        && textKind(r.setNameKind) && textKind(r.propertyNameKind)
        && validReadOptions(value) && validComparison(value)
        && (r.nameCaseMode === undefined || r.nameCaseMode === 'exact')
        && (r.legacyListFirst === undefined || r.legacyListFirst === true);
    case 'quantity':
      return typeof r.setName === 'string' && typeof r.quantityName === 'string'
        && NUMERIC_OPS.has(r.op) && finiteNumber(r.value)
        && textKind(r.setNameKind) && textKind(r.quantityNameKind) && validReadOptions(value);
    case 'elevation':
      return NUMERIC_OPS.has(r.op) && finiteNumber(r.value);
    case 'listCondition':
      return isListConditionRule(value);
    case 'modelFact':
      return isModelFact(r.fact) && VALUE_OPS.has(r.op) && typeof r.value === 'string';
    default:
      return false;
  }
}

/** `SubjectReadOptions` fields, when present, must hold a value the engine
 *  knows; `memberPath` only on a `property` rule. */
function validReadOptions(value: object): boolean {
  const r = value as { kind?: unknown; valueUnit?: unknown; inherit?: unknown; memberPath?: unknown };
  return (r.valueUnit === undefined || r.valueUnit === 'si')
    && (r.inherit === undefined || r.inherit === 'type' || r.inherit === 'aggregation')
    && (r.memberPath === undefined || (r.kind === 'property' && isMemberPath(r.memberPath)));
}

function validComparison(value: object): boolean {
  const options = (value as { comparison?: unknown }).comparison;
  if (options === undefined) return true;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return false;
  const o = options as Record<string, unknown>;
  return (o.caseMode === undefined || o.caseMode === 'fold' || o.caseMode === 'exact'
      || o.caseMode === 'lensBoolean' || o.caseMode === 'ifcBoolean')
    && (o.numericMode === undefined || o.numericMode === 'prefix' || o.numericMode === 'strict')
    && o.typeMode === undefined && o.operandType === undefined;
}

export function parseFilterRules(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterRule);
}
