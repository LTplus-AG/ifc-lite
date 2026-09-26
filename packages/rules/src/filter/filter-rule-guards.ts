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
import type { ClassificationOp, FilterRule, StringOp, ValueOp } from './filter-rules.js';

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

export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'modelTag') {
    // Structural: a bad op or a non-string id must not reach the evaluator.
    const r = value as { op?: unknown; tagIds?: unknown };
    return isModelTagOp(r.op) && Array.isArray(r.tagIds) && r.tagIds.every((t) => typeof t === 'string');
  }
  if (kind === 'parent') {
    // Structural: `matchParentRule` lower-cases `value` per ancestor, so a
    // persisted non-string value (or an unknown op) must not reach it.
    const r = value as { op?: unknown; value?: unknown; valueKind?: unknown };
    return (
      STRING_OPS.has(r.op) &&
      typeof r.value === 'string' &&
      (r.valueKind === undefined || r.valueKind === 'literal' || r.valueKind === 'regex')
    );
  }
  if (kind === 'group') {
    // Structural, like `parent`: `matchGroupRule` reads `value` as text and
    // `groupClass` as a class name, so neither may arrive as anything else.
    const r = value as { op?: unknown; value?: unknown; valueKind?: unknown; groupClass?: unknown };
    return (
      CLASSIFICATION_OPS.has(r.op) &&
      typeof r.value === 'string' &&
      (r.groupClass === undefined || typeof r.groupClass === 'string') &&
      (r.valueKind === undefined || r.valueKind === 'literal' || r.valueKind === 'regex')
    );
  }
  if ((kind === 'property' || kind === 'quantity') && !validReadOptions(value)) return false;
  if ((kind === 'property' || kind === 'attribute') && !validComparison(value)) return false;
  if (kind === 'modelFact') {
    const r = value as { fact?: unknown; op?: unknown; value?: unknown };
    return isModelFact(r.fact) && VALUE_OPS.has(r.op) && typeof r.value === 'string';
  }
  return (
    kind === 'model' ||
    kind === 'storey' ||
    kind === 'ifcType' ||
    kind === 'predefinedType' ||
    kind === 'name' ||
    kind === 'globalId' ||
    kind === 'attribute' ||
    kind === 'property' ||
    kind === 'quantity' ||
    kind === 'material' ||
    kind === 'classification' ||
    kind === 'elevation' ||
    kind === 'type'
  );
}

/** `SubjectReadOptions` fields, when present, must hold a value the engine knows. */
function validReadOptions(value: object): boolean {
  const r = value as { valueUnit?: unknown; inherit?: unknown };
  return (r.valueUnit === undefined || r.valueUnit === 'si')
    && (r.inherit === undefined || r.inherit === 'type' || r.inherit === 'aggregation');
}

function validComparison(value: object): boolean {
  const options = (value as { comparison?: unknown }).comparison;
  if (options === undefined) return true;
  if (options === null || typeof options !== 'object') return false;
  const o = options as Record<string, unknown>;
  return (o.caseMode === undefined || o.caseMode === 'fold' || o.caseMode === 'exact'
      || o.caseMode === 'lensBoolean' || o.caseMode === 'ifcBoolean')
    && (o.numericMode === undefined || o.numericMode === 'prefix' || o.numericMode === 'strict')
    && (o.typeMode === undefined || o.typeMode === 'bulk')
    && (o.operandType === undefined || o.operandType === 'string' || o.operandType === 'number'
      || o.operandType === 'boolean' || o.operandType === 'null' || o.operandType === 'undefined'
      || o.operandType === 'array');
}

export function parseFilterRules(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterRule);
}
