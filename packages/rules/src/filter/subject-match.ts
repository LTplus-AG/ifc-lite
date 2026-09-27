/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `property` / `quantity` rules that set a {@link SubjectReadOptions} field
 * are read through `readSubject`, the reader validation already uses, so
 * the option means one thing in search, applicability and validation.
 *
 * `readSubject` reads the model as loaded. A live in-session edit is
 * applied to plain property rules through the mutation overlay
 * (`filter-evaluate-mutations.ts`), but not to a rule that sets one of these
 * options. Validation has the same limitation today (see `read-subject.ts`).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { PropertyRule, QuantityRule } from './filter-rules.js';
import { numericOpMatches, valueOpMatches } from './filter-ops.js';
import { readSubject, type SubjectValue } from './read-subject.js';
import { NEGATED_VALUE_OP } from './filter-match.js';

/**
 * `subject` with every value that has a unit converted to SI base units.
 * A value with no SI factor (a label, a count) is left as it is.
 */
export function toSiValues(subject: SubjectValue): SubjectValue {
  const scales = subject.valueSiScales;
  if (!scales) return subject;
  let converted = false;
  const values = subject.values.map((value, i) => {
    const scale = scales[i];
    if (scale === undefined) return value;
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'string' && value.trim() === '') return value;
    if (!Number.isFinite(n)) return value;
    converted = true;
    const si = n * scale;
    return typeof value === 'number' ? si : String(si);
  });
  // The stored unit label no longer describes the values; say they are SI.
  return converted ? { ...subject, values, unit: 'SI' } : subject;
}

/** The subject's values as the rule compares them. */
export function readRuleSubject(
  rule: PropertyRule | QuantityRule,
  store: IfcDataStore,
  expressId: number,
): SubjectValue {
  const subject = readSubject(rule, { store, expressId });
  return rule.valueUnit === 'si' ? toSiValues(subject) : subject;
}

/**
 * Search semantics (`matchPropertyRule` / `matchQuantityRule`), read through
 * `readSubject`: presence ops ask whether any value exists, every other op
 * passes when ANY value satisfies it.
 */
export function matchRuleThroughSubject(
  rule: PropertyRule | QuantityRule,
  store: IfcDataStore,
  expressId: number,
): boolean {
  const subject = readRuleSubject(rule, store, expressId);
  if (rule.kind === 'quantity') {
    return subject.values.some((v) => numericOpMatches(rule.op, Number(v), rule.value));
  }
  if (rule.op === 'isSet') return subject.present;
  if (rule.op === 'isNotSet') return !subject.present;
  // Same NONE rule as `matchPropertyRule` for a list / table read member by member (#5475).
  const positive = NEGATED_VALUE_OP[rule.op];
  if (positive) {
    return subject.values.length > 0
      && !subject.values.some((v) => valueOpMatches(positive, String(v), rule.value, rule.valueKind));
  }
  return subject.values.some((v) => valueOpMatches(rule.op, String(v), rule.value, rule.valueKind));
}
