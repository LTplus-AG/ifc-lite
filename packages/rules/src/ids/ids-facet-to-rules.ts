/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One IDS facet → the `FilterRule`s that check exactly the same thing, or
 * the reason it has none (#5225). Used by `ids-to-rule-set.ts` for the
 * facets of both applicability and (required) requirements.
 */

import type { IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import { normalizeIfcTypeName } from '@ifc-lite/parser';
import type { FilterRule, NumericOp, TextKind } from '../filter/filter-rules.js';
import { Rule } from '../filter/filter-rules.js';
import { idsPatternToJsRegex } from './ids-regex.js';

export type FacetRules = { ok: true; rules: FilterRule[]; notes?: string[] } | { ok: false; reason: string };

/** IDS states measure values in SI units; the engine compares them as stored (#5292 review). */
export const SI_UNITS_NOTE =
  'IDS states measure values in SI units; the imported rules compare them with the value as stored in the model, ' +
  'so a numeric check on a length, area or volume only agrees with IDS for a model authored in SI units';

type Role = 'applicability' | 'requirement';

/** A rule operand for a string constraint: exact text, or a regex literal. */
type TextOperand =
  | { op: 'eq'; value: string }
  | { op: 'matches'; value: string };

/** JS-escape `text` so it matches only itself inside a regex. */
function escapeJs(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

function describe(c: IDSConstraint): string {
  return c.type === 'simpleValue' ? `"${c.value}"` : `a ${c.type} restriction`;
}

/** Anything a single-family constraint does not cover blocks the facet. */
function compound(c: IDSConstraint): boolean {
  return c.type !== 'simpleValue' && !!c.and && c.and.length > 0;
}

function textOperand(c: IDSConstraint): TextOperand | string {
  if (compound(c)) return 'a restriction combining several facets has no rule equivalent';
  switch (c.type) {
    case 'simpleValue':
      return { op: 'eq', value: c.value };
    case 'pattern': {
      const converted = idsPatternToJsRegex(c.pattern);
      return converted.ok ? { op: 'matches', value: converted.pattern } : `pattern "${c.pattern}": ${converted.reason}`;
    }
    case 'enumeration': {
      if (c.values.length === 0) return 'an empty enumeration matches nothing';
      if (c.base && c.base !== 'xs:string') {
        return `an enumeration of ${c.base} values compares numbers, which a text rule cannot`;
      }
      if (c.values.length === 1) return { op: 'eq', value: c.values[0] };
      return { op: 'matches', value: `/^(?:${c.values.map(escapeJs).join('|')})$/u` };
    }
    case 'bounds':
      return 'a numeric bound on a name has no rule equivalent';
  }
}

/** Numeric bounds → `gt`/`gte`/`lt`/`lte` pairs, or why not. */
function numericOps(c: IDSConstraint): Array<{ op: NumericOp; value: number }> | string {
  if (c.type !== 'bounds') return 'not a numeric bound';
  if (compound(c)) return 'a restriction combining several facets has no rule equivalent';
  const lengthLike = [c.length, c.minLength, c.maxLength, c.totalDigits, c.fractionDigits];
  if (lengthLike.some((v) => v !== undefined)) return 'length and digit restrictions have no rule equivalent';
  const bounds = [c.minInclusive, c.minExclusive, c.maxInclusive, c.maxExclusive];
  if (bounds.some((v) => v !== undefined && !Number.isFinite(v))) return 'a bound that is not a finite number';
  const ops: Array<{ op: NumericOp; value: number }> = [];
  if (c.minInclusive !== undefined) ops.push({ op: 'gte', value: c.minInclusive });
  if (c.minExclusive !== undefined) ops.push({ op: 'gt', value: c.minExclusive });
  if (c.maxInclusive !== undefined) ops.push({ op: 'lte', value: c.maxInclusive });
  if (c.maxExclusive !== undefined) ops.push({ op: 'lt', value: c.maxExclusive });
  return ops.length > 0 ? ops : 'an empty bound';
}

/** Set/property NAME: literal text, or a regex literal (read by `nameMatches`). */
function nameOperand(c: IDSConstraint, what: string): { name: string; kind: TextKind } | { name: string; kind?: undefined } | string {
  if (c.type === 'simpleValue') return { name: c.value, kind: 'literal' };
  if (c.type === 'pattern') {
    const operand = textOperand(c);
    return typeof operand === 'string' ? `${what}: ${operand}` : { name: operand.value };
  }
  return `${what} given as ${describe(c)} has no rule equivalent`;
}

/** Values for an `in` rule (`ifcType`, `predefinedType`, `globalId`). */
function setValues(c: IDSConstraint, what: string): string[] | string {
  if (compound(c)) return `${what}: a restriction combining several facets has no rule equivalent`;
  if (c.type === 'simpleValue') return [c.value];
  if (c.type === 'enumeration' && c.values.length > 0) {
    if (c.base && c.base !== 'xs:string') return `${what}: an enumeration of ${c.base} values has no rule equivalent`;
    return [...c.values];
  }
  return `${what} given as ${describe(c)} has no rule equivalent`;
}

function entityRules(facet: Extract<IDSFacet, { type: 'entity' }>, role: Role): FacetRules {
  if (role === 'requirement') {
    return { ok: false, reason: 'an entity facet in the requirements is exact-class, which a rule requirement cannot express' };
  }
  const names = setValues(facet.name, 'entity name');
  if (typeof names === 'string') return { ok: false, reason: names };
  const rules: FilterRule[] = [{ kind: 'ifcType', op: 'in', values: names.map(normalizeIfcTypeName), exactClass: true }];
  if (facet.predefinedType) {
    const types = setValues(facet.predefinedType, 'predefinedType');
    if (typeof types === 'string') return { ok: false, reason: types };
    rules.push(Rule.predefinedType(types, 'in'));
  }
  return { ok: true, rules };
}

function attributeRules(facet: Extract<IDSFacet, { type: 'attribute' }>, role: Role): FacetRules {
  if (facet.name.type !== 'simpleValue') {
    return { ok: false, reason: `an attribute name given as ${describe(facet.name)} has no rule equivalent` };
  }
  const name = facet.name.value;
  if (name === 'GlobalId' || name === 'PredefinedType') {
    if (name === 'GlobalId' && role === 'requirement') {
      return { ok: false, reason: 'a GlobalId requirement has no rule equivalent (GlobalId only selects elements)' };
    }
    if (!facet.value) return { ok: false, reason: `a presence check on ${name} has no rule equivalent` };
    const values = setValues(facet.value, name);
    if (typeof values === 'string') return { ok: false, reason: values };
    return { ok: true, rules: [name === 'GlobalId' ? Rule.globalId(values, 'in') : Rule.predefinedType(values, 'in')] };
  }
  if (!facet.value) return { ok: true, rules: [Rule.attribute(name, 'isSet', '')] };
  if (facet.value.type === 'bounds') {
    const ops = numericOps(facet.value);
    if (typeof ops === 'string') return { ok: false, reason: `${name}: ${ops}` };
    return { ok: true, rules: ops.map(({ op, value }) => Rule.attribute(name, op, String(value))) };
  }
  const operand = textOperand(facet.value);
  if (typeof operand === 'string') return { ok: false, reason: `${name}: ${operand}` };
  return { ok: true, rules: [Rule.attribute(name, operand.op, operand.value)] };
}

function propertyRules(facet: Extract<IDSFacet, { type: 'property' }>): FacetRules {
  if (facet.dataType) {
    return { ok: false, reason: 'a property dataType check has no rule equivalent' };
  }
  const set = nameOperand(facet.propertySet, 'propertySet');
  if (typeof set === 'string') return { ok: false, reason: set };
  const base = nameOperand(facet.baseName, 'baseName');
  if (typeof base === 'string') return { ok: false, reason: base };
  const kinds = {
    ...(set.kind ? { setNameKind: set.kind } : {}),
    ...(base.kind ? { propertyNameKind: base.kind } : {}),
  };
  const label = `${set.name}.${base.name}`;

  // `Qto_` is IFC's reserved prefix for quantity sets, which the rule
  // engine reads through the `quantity` subject, not `property`.
  if (set.kind === 'literal' && set.name.startsWith('Qto_')) {
    const qtyKinds = { setNameKind: set.kind, ...(base.kind ? { quantityNameKind: base.kind } : {}) };
    if (!facet.value) return { ok: false, reason: `${label}: a quantity presence check has no rule equivalent` };
    if (facet.value.type === 'simpleValue') {
      const text = facet.value.value.trim();
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) return { ok: false, reason: `${label}: "${facet.value.value}" is not a number` };
      return { ok: true, rules: [Rule.quantity(set.name, base.name, 'eq', n, qtyKinds)], notes: [SI_UNITS_NOTE] };
    }
    const ops = numericOps(facet.value);
    if (typeof ops === 'string') return { ok: false, reason: `${label}: ${ops}` };
    return {
      ok: true,
      rules: ops.map(({ op, value }) => Rule.quantity(set.name, base.name, op, value, qtyKinds)),
      notes: [SI_UNITS_NOTE],
    };
  }

  if (!facet.value) return { ok: true, rules: [Rule.property(set.name, base.name, 'isSet', '', kinds)] };
  if (facet.value.type === 'bounds') {
    const ops = numericOps(facet.value);
    if (typeof ops === 'string') return { ok: false, reason: `${label}: ${ops}` };
    return {
      ok: true,
      rules: ops.map(({ op, value }) => Rule.property(set.name, base.name, op, String(value), kinds)),
      notes: [SI_UNITS_NOTE],
    };
  }
  const operand = textOperand(facet.value);
  if (typeof operand === 'string') return { ok: false, reason: `${label}: ${operand}` };
  return { ok: true, rules: [Rule.property(set.name, base.name, operand.op, operand.value, kinds)] };
}

/** Map one facet. `role` matters only for the entity facet and GlobalId. */
export function facetToRules(facet: IDSFacet, role: Role): FacetRules {
  switch (facet.type) {
    case 'entity':
      return entityRules(facet, role);
    case 'attribute':
      return attributeRules(facet, role);
    case 'property':
      return propertyRules(facet);
    case 'classification': {
      if (facet.value) {
        return { ok: false, reason: 'a classification code check matches the code only; the rule matches a code OR a name' };
      }
      if (facet.system && facet.system.type !== 'simpleValue') {
        return { ok: false, reason: `a classification system given as ${describe(facet.system)} has no rule equivalent` };
      }
      return { ok: true, rules: [Rule.classification(facet.system?.value ?? '', 'isSet', '')] };
    }
    case 'material': {
      // No material presence operator exists; any non-empty material name
      // is the same check (and `ruleSetToIds` exports it back as presence).
      if (!facet.value) return { ok: true, rules: [Rule.material('matches', '.', 'regex')] };
      const operand = textOperand(facet.value);
      if (typeof operand === 'string') return { ok: false, reason: `material: ${operand}` };
      return { ok: true, rules: [Rule.material(operand.op, operand.value)] };
    }
    case 'partOf':
      return { ok: false, reason: 'a partOf facet (containment, aggregation, …) has no rule equivalent' };
  }
}
