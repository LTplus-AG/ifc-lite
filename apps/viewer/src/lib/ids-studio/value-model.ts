/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The value editor's model (IDS-035): every `ConstraintDraft` kind as form
 * state, read back from a stored `IDSConstraint` and written as a draft for
 * a `facet.setField` op. The reducer normalises the draft (units to SI,
 * upper-case entity names); this module never builds an `IDSConstraint`.
 */

import { matchConstraint, type IDSConstraint } from '@ifc-lite/ids';
import type { ConstraintDraft, ValueInput, XsdBase } from '@ifc-lite/ids-authoring';
import { splitQuantity } from './units';

export type ValueKind = 'any' | 'equals' | 'oneOf' | 'pattern' | 'range' | 'length' | 'digits' | 'raw';

/** Form state. Numbers are kept as typed text until written. */
export interface ValueForm {
  kind: ValueKind;
  text: string;
  values: string[];
  pattern: string;
  min: string;
  max: string;
  minInclusive: boolean;
  maxInclusive: boolean;
  /** Unit of the range numbers (`mm`, `kN`, …); empty = SI. */
  unit: string;
  exact: string;
  total: string;
  fraction: string;
  /** The stored constraint when it has no form of its own (a conjunction). */
  raw?: IDSConstraint;
}

export const VALUE_KINDS: readonly ValueKind[] = ['any', 'equals', 'oneOf', 'pattern', 'range', 'length', 'digits'];

export function emptyForm(kind: ValueKind = 'any'): ValueForm {
  return { kind, text: '', values: [], pattern: '', min: '', max: '', minInclusive: true, maxInclusive: true, unit: '', exact: '', total: '', fraction: '' };
}

const num = (n: number | undefined): string => (n === undefined ? '' : String(n));

/** The editor form for a stored constraint (`undefined` = any value). */
export function formFromConstraint(c: IDSConstraint | undefined): ValueForm {
  const form = emptyForm();
  if (!c) return form;
  if (c.type !== 'simpleValue' && c.and?.length) return { ...form, kind: 'raw', raw: c };
  switch (c.type) {
    case 'simpleValue': return { ...form, kind: 'equals', text: c.value };
    case 'enumeration': return { ...form, kind: 'oneOf', values: [...c.values] };
    case 'pattern': return { ...form, kind: 'pattern', pattern: c.pattern };
    case 'bounds': {
      const range = [c.minInclusive, c.minExclusive, c.maxInclusive, c.maxExclusive].some((v) => v !== undefined);
      const length = [c.length, c.minLength, c.maxLength].some((v) => v !== undefined);
      const digits = [c.totalDigits, c.fractionDigits].some((v) => v !== undefined);
      if (Number(range) + Number(length) + Number(digits) !== 1 || c.unparseableFacets?.length) return { ...form, kind: 'raw', raw: c };
      if (range) {
        return {
          ...form, kind: 'range',
          min: num(c.minInclusive ?? c.minExclusive), minInclusive: c.minExclusive === undefined,
          max: num(c.maxInclusive ?? c.maxExclusive), maxInclusive: c.maxExclusive === undefined,
        };
      }
      if (length) return { ...form, kind: 'length', exact: num(c.length), min: num(c.minLength), max: num(c.maxLength) };
      return { ...form, kind: 'digits', total: num(c.totalDigits), fraction: num(c.fractionDigits) };
    }
  }
}

/** A typed number, or `undefined` for blank. `NaN` marks text that is not a number. */
function parseNumber(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  return Number(t.replace(/\s+/g, ''));
}

export type FormProblem = 'number' | 'empty' | 'unit';

/**
 * The value input to dispatch for `form`, or a problem the form shows inline.
 * `base` is the XSD base implied by the property's data type, if any. The
 * gate still validates the result (bounds order, pattern syntax, ReDoS).
 */
export function inputFromForm(form: ValueForm, base?: string): { input: ValueInput | null } | { problem: FormProblem } {
  const xsBase = base as XsdBase | undefined;
  const withBase = <T extends ConstraintDraft>(draft: T): T => (xsBase ? { ...draft, base: xsBase } : draft);
  switch (form.kind) {
    case 'any': return { input: null };
    case 'raw': return form.raw ? { input: { kind: 'raw', constraint: form.raw } } : { problem: 'empty' };
    case 'equals': return form.text === '' ? { problem: 'empty' } : { input: { kind: 'equals', value: form.text } };
    case 'oneOf': return form.values.length ? { input: withBase({ kind: 'oneOf', values: form.values }) } : { problem: 'empty' };
    case 'pattern': return form.pattern ? { input: withBase({ kind: 'pattern', pattern: form.pattern }) } : { problem: 'empty' };
    case 'range': {
      // Unit-aware bounds (IDS-045): "2400 mm" carries its own unit.
      const low = splitQuantity(form.min), high = splitQuantity(form.max);
      const units = [...new Set([form.unit.trim(), low.unit, high.unit].filter((u): u is string => !!u))];
      if (units.length > 1) return { problem: 'unit' };
      const min = parseNumber(low.number), max = parseNumber(high.number);
      if (Number.isNaN(min) || Number.isNaN(max)) return { problem: 'number' };
      if (min === undefined && max === undefined) return { problem: 'empty' };
      return { input: withBase({
        kind: 'range',
        ...(min === undefined ? {} : { min, minInclusive: form.minInclusive }),
        ...(max === undefined ? {} : { max, maxInclusive: form.maxInclusive }),
        ...(units.length ? { unit: units[0] } : {}),
      }) };
    }
    case 'length': {
      const exact = parseNumber(form.exact), min = parseNumber(form.min), max = parseNumber(form.max);
      if ([exact, min, max].some((n) => Number.isNaN(n))) return { problem: 'number' };
      if (exact === undefined && min === undefined && max === undefined) return { problem: 'empty' };
      return { input: { kind: 'length', ...(exact === undefined ? {} : { exact }), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) } };
    }
    case 'digits': {
      const total = parseNumber(form.total), fraction = parseNumber(form.fraction);
      if (Number.isNaN(total) || Number.isNaN(fraction)) return { problem: 'number' };
      if (total === undefined && fraction === undefined) return { problem: 'empty' };
      return { input: { kind: 'digits', ...(total === undefined ? {} : { total }), ...(fraction === undefined ? {} : { fraction }) } };
    }
  }
}

/**
 * Split pasted text into enumeration values: one per line, or separated by
 * `;` / tabs (a spreadsheet column or row). Commas are kept, since values
 * such as `EI 30, smoke-tight` contain them. Blank and repeated entries drop.
 */
export function splitPastedValues(text: string): string[] {
  const parts = text.split(/\r?\n|;|\t/).map((p) => p.trim()).filter(Boolean);
  return [...new Set(parts)];
}

const NUMERIC_BASES = new Set(['xs:double', 'xs:decimal', 'xs:integer', 'xs:float']);

/**
 * Does `sample` satisfy the stored constraint? Uses the validator's own
 * matcher, so the live example agrees with a real check. Numeric bases and
 * ranges compare the sample as a number.
 */
export function sampleMatches(constraint: IDSConstraint, sample: string, base?: string): boolean {
  const numeric = constraint.type === 'bounds'
    ? [constraint.minInclusive, constraint.minExclusive, constraint.maxInclusive, constraint.maxExclusive].some((v) => v !== undefined)
    : NUMERIC_BASES.has(base ?? ('base' in constraint ? constraint.base ?? '' : ''));
  const value = numeric && sample.trim() !== '' && Number.isFinite(Number(sample)) ? Number(sample) : sample;
  return matchConstraint(constraint, value);
}
