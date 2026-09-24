/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One `FilterGroup` of a rule → the IDS facets that check exactly the same
 * thing, or the reasons it has none (#5225). Used for both the
 * applicability and the `element` requirement of a rule by
 * `rule-set-to-ids.ts`.
 *
 * What maps, and why only this:
 * - `ifcType` (+ `predefinedType`) → one entity facet, only with
 *   `exactClass: true`: an IDS entity facet matches the exact class, while
 *   a rule without `exactClass` matches subclasses too. Applicability only;
 *   in a requirement the engine compares the class without `exactClass`.
 * - `name` / `attribute` / `globalId` → attribute facets.
 * - `property` → property facet; `quantity` → property facet on the
 *   quantity set (IDS 1.0 checks quantities through the property facet).
 * - `material` → material facet; `classification` presence → classification
 *   facet (a code/name value does not map: the rule matches a reference's
 *   code OR name, IDS only its code).
 * - Operators `eq`, `contains`, `startsWith`, `matches`, `isSet`, `in`
 *   and the numeric bounds (`gt`/`gte`/`lt`/`lte`, a `between` pair folds
 *   into one restriction). Negations have no IDS form in a required facet.
 */

import type { IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import type { FilterGroup } from '../filter/filter-groups.js';
import type { FilterRule, NumericOp, PropertyRule, QuantityRule, TextKind } from '../filter/filter-rules.js';
import { escapeXsdLiteral, hasAstralCaveat, jsRegexOf, jsRegexToIdsPattern, type JsRegex } from './ids-regex.js';

export type FacetRole = 'applicability' | 'requirement';

export type GroupFacets =
  | { ok: true; facets: IDSFacet[]; notes: string[] }
  | { ok: false; reasons: string[] };

const NEGATED_OPS = new Set(['ne', 'notContains', 'notMatches', 'isNotSet', 'notIn']);

/** A `/body/flags` literal: how a name with no declared kind says "pattern". */
const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

type Mapped = { facet: IDSFacet; boundsKey?: string } | { reason: string };

function simpleOrEnumeration(values: readonly string[]): IDSConstraint {
  return values.length === 1
    ? { type: 'simpleValue', value: values[0] }
    : { type: 'enumeration', values: [...values] };
}

/** A set/property/quantity NAME as the engine reads it (`nameMatches`). */
function nameConstraint(name: string, kind: TextKind | undefined): IDSConstraint | string {
  const isRegex = kind === 'regex' || (kind === undefined && REGEX_LITERAL.test(name));
  if (!isRegex) return { type: 'simpleValue', value: name };
  const converted = jsRegexToIdsPattern(jsRegexOf(name, kind));
  return converted.ok ? { type: 'pattern', pattern: converted.pattern } : `name pattern "${name}": ${converted.reason}`;
}

function boundsOf(op: NumericOp, value: number): IDSConstraint {
  switch (op) {
    case 'gt': return { type: 'bounds', minExclusive: value };
    case 'gte': return { type: 'bounds', minInclusive: value };
    case 'lt': return { type: 'bounds', maxExclusive: value };
    case 'lte': return { type: 'bounds', maxInclusive: value };
    default: return { type: 'simpleValue', value: String(value) };
  }
}

/**
 * The value constraint for a rule operator, `null` for a bare presence
 * check (`isSet`), or a refusal reason.
 */
function valueConstraint(op: string, value: string, valueKind: TextKind | undefined): IDSConstraint | null | string {
  switch (op) {
    case 'isSet':
      return null;
    case 'eq':
      return { type: 'simpleValue', value };
    case 'contains':
      return { type: 'pattern', pattern: `.*${escapeXsdLiteral(value)}.*` };
    case 'startsWith':
      return { type: 'pattern', pattern: `${escapeXsdLiteral(value)}.*` };
    case 'matches': {
      const converted = jsRegexToIdsPattern(jsRegexOf(value, valueKind));
      return converted.ok ? { type: 'pattern', pattern: converted.pattern } : `pattern "${value}": ${converted.reason}`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) return `"${value}" is not a number, so "${op}" has no IDS bound`;
      return boundsOf(op, n);
    }
    default:
      return `operator "${op}" has no IDS equivalent`;
  }
}

/**
 * How a numeric check on a value stored in model units reaches SI, which
 * IDS states every measure in (#5225 decision). `scale` converts the
 * rule's operand to SI; `unitless` means the value has no unit, so it
 * exports as it is; `unknown` carries why the unit could not be settled.
 */
export type StoredUnitScale =
  | { kind: 'scale'; scale: number }
  | { kind: 'unitless' }
  | { kind: 'unknown'; reason: string };

export type StoredUnitScaleOf = (rule: PropertyRule | QuantityRule) => StoredUnitScale;

const NO_MODEL: StoredUnitScaleOf = () => ({
  kind: 'unknown',
  reason: 'the value is compared in model units, and converting it to the SI units IDS uses needs a loaded model',
});

/** `c` with every number multiplied by `scale`. */
function scaleConstraint(c: IDSConstraint, scale: number): IDSConstraint {
  if (c.type === 'simpleValue') return { ...c, value: String(Number(c.value) * scale) };
  if (c.type !== 'bounds') return c;
  const out = { ...c };
  for (const key of ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive'] as const) {
    if (out[key] !== undefined) out[key] = (out[key] as number) * scale;
  }
  return out;
}

const ASTRAL_NOTE =
  'A pattern without the "u" flag reads an emoji or other character outside the Basic Multilingual Plane as two ' +
  'characters in the rule engine and as one in IDS, so ".", "[^…]" and "\\D" can disagree on such values';

/** The astral-plane caveat, when the rule's value or set/property name is such a regex. */
function regexNote(rule: FilterRule): string | undefined {
  const regexes: JsRegex[] = [];
  if ('op' in rule && rule.op === 'matches' && 'value' in rule && typeof rule.value === 'string') {
    regexes.push(jsRegexOf(rule.value, 'valueKind' in rule ? rule.valueKind : undefined));
  }
  if (rule.kind === 'property' || rule.kind === 'quantity') {
    const baseName = rule.kind === 'property' ? rule.propertyName : rule.quantityName;
    const baseKind = rule.kind === 'property' ? rule.propertyNameKind : rule.quantityNameKind;
    const names: Array<[string, TextKind | undefined]> = [[rule.setName, rule.setNameKind], [baseName, baseKind]];
    for (const [name, kind] of names) {
      if (kind === 'regex' || (kind === undefined && REGEX_LITERAL.test(name))) regexes.push(jsRegexOf(name, kind));
    }
  }
  return regexes.some(hasAstralCaveat) ? ASTRAL_NOTE : undefined;
}

function mapRule(rule: FilterRule, scaleOf: StoredUnitScaleOf): Mapped {
  if ('op' in rule && NEGATED_OPS.has(rule.op)) {
    return { reason: `a negated condition ("${rule.op}") cannot be expressed in IDS 1.0` };
  }
  switch (rule.kind) {
    case 'model':
    case 'modelTag':
      return { reason: 'targeting a model or model tag has no IDS equivalent (an IDS is run against one model)' };
    case 'storey':
      return { reason: 'storey membership by name has no IDS facet' };
    case 'elevation':
      return { reason: 'storey elevation has no IDS facet' };
    case 'type':
      return { reason: 'the relating type name has no IDS facet' };
    case 'parent':
      return { reason: 'an ancestor matched by name has no IDS facet (partOf matches a class)' };
    case 'group':
      // IDS's partOf IfcRelAssignsToGroup names the group's exact class only:
      // no Name match, and no subclass expansion of `groupClass`.
      return { reason: 'group membership by name or by class-with-subclasses has no IDS facet (partOf matches one exact class)' };
    case 'modelFact':
      return { reason: 'a model-level fact (georeferencing, units, header) has no IDS facet' };
    case 'globalId':
      return { facet: { type: 'attribute', name: { type: 'simpleValue', value: 'GlobalId' }, value: simpleOrEnumeration(rule.values) } };
    case 'name':
    case 'attribute': {
      const attrName = rule.kind === 'name' ? 'Name' : rule.name;
      const value = valueConstraint(rule.op, rule.value, rule.valueKind);
      if (typeof value === 'string') return { reason: value };
      return {
        facet: { type: 'attribute', name: { type: 'simpleValue', value: attrName }, ...(value ? { value } : {}) },
        boundsKey: value?.type === 'bounds' ? `attribute:${attrName}` : undefined,
      };
    }
    case 'property':
    case 'quantity': {
      const isQuantity = rule.kind === 'quantity';
      const setName = nameConstraint(rule.setName, rule.setNameKind);
      const baseName = isQuantity
        ? nameConstraint(rule.quantityName, rule.quantityNameKind)
        : nameConstraint(rule.propertyName, rule.propertyNameKind);
      if (typeof setName === 'string') return { reason: setName };
      if (typeof baseName === 'string') return { reason: baseName };
      const value = isQuantity
        ? boundsOf(rule.op, rule.value)
        : valueConstraint(rule.op, rule.value, rule.valueKind);
      if (typeof value === 'string') return { reason: value };
      const key = `${rule.kind}:${rule.setName}:${isQuantity ? rule.quantityName : rule.propertyName}`;
      const numeric = value !== null && (isQuantity || value.type === 'bounds'
        || (value.type === 'simpleValue' && value.value.trim() !== '' && Number.isFinite(Number(value.value))));
      let exported = value;
      if (numeric && value && rule.valueUnit !== 'si') {
        const stored = scaleOf(rule);
        if (stored.kind === 'unknown') return { reason: stored.reason };
        if (stored.kind === 'scale') exported = scaleConstraint(value, stored.scale);
      }
      return {
        facet: { type: 'property', propertySet: setName, baseName, ...(exported ? { value: exported } : {}) },
        boundsKey: value?.type === 'bounds' ? key : undefined,
      };
    }
    case 'material': {
      // `matches .` (any non-empty name) is how the rule vocabulary, which
      // has no material presence operator, spells "has a material"; the IDS
      // spelling of the same check is a material facet without a value.
      if (rule.op === 'matches' && rule.valueKind === 'regex' && rule.value === '.') {
        return { facet: { type: 'material' } };
      }
      const value = valueConstraint(rule.op, rule.value, rule.valueKind);
      if (typeof value === 'string') return { reason: value };
      return { facet: { type: 'material', ...(value ? { value } : {}) } };
    }
    case 'classification': {
      if (rule.op !== 'isSet') {
        return { reason: 'a classification value check matches a code OR a name; the IDS classification facet matches the code only' };
      }
      const system = rule.system?.trim();
      return { facet: { type: 'classification', ...(system ? { system: { type: 'simpleValue', value: system } } : {}) } };
    }
    case 'ifcType':
    case 'predefinedType':
      // Folded into one entity facet by `entityFacetOf`.
      return { reason: `${rule.kind} is handled as an entity facet` };
    default: {
      const exhaustive: never = rule;
      return { reason: `unknown rule kind ${JSON.stringify(exhaustive)}` };
    }
  }
}

/** The group's `ifcType`/`predefinedType` rules as one entity facet. */
function entityFacetOf(rules: readonly FilterRule[], role: FacetRole, reasons: string[]): IDSFacet | null {
  const types = rules.filter((r) => r.kind === 'ifcType');
  const predefined = rules.filter((r) => r.kind === 'predefinedType');
  if (types.length === 0 && predefined.length === 0) return null;
  if (role === 'requirement') {
    reasons.push('an IFC class requirement has no exact-class form in the rule engine, while an IDS entity facet is exact-class');
    return null;
  }
  if (types.length !== 1) {
    reasons.push(types.length === 0
      ? 'a PredefinedType condition needs an IFC class condition in the same group (IDS keeps it inside the entity facet)'
      : 'several IFC class conditions in one group have no single IDS entity facet');
    return null;
  }
  const [type] = types;
  if (type.kind !== 'ifcType') return null;
  if (type.op !== 'in') return null; // negation already reported by `mapRule`'s caller
  if (type.exactClass !== true) {
    reasons.push('the IFC class condition includes subclasses (exactClass is off); an IDS entity facet matches the exact class only');
    return null;
  }
  if (predefined.length > 1) {
    reasons.push('several PredefinedType conditions in one group have no single IDS entity facet');
    return null;
  }
  const pt = predefined[0];
  if (pt && (pt.kind !== 'predefinedType' || pt.op !== 'in')) return null;
  return {
    type: 'entity',
    name: simpleOrEnumeration(type.values.map((v) => v.toUpperCase())),
    ...(pt && pt.kind === 'predefinedType' ? { predefinedType: simpleOrEnumeration(pt.values) } : {}),
  };
}

type Bounds = Extract<IDSConstraint, { type: 'bounds' }>;
const BOUND_KEYS = ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive'] as const;

/** Merge `extra`'s bounds into `into`; a reason when both set the same side. */
function mergeBounds(into: Bounds, extra: Bounds): string | null {
  for (const key of BOUND_KEYS) {
    if (extra[key] === undefined) continue;
    const side = key.startsWith('min') ? ['minInclusive', 'minExclusive'] as const : ['maxInclusive', 'maxExclusive'] as const;
    if (side.some((k) => into[k] !== undefined)) return 'two bounds on the same side of one value have no single IDS restriction';
    into[key] = extra[key];
  }
  return null;
}

function facetValue(facet: IDSFacet): IDSConstraint | undefined {
  return facet.type === 'attribute' || facet.type === 'property' ? facet.value : undefined;
}

/** Map one group. Every reason is collected, not just the first. */
export function groupToFacets(group: FilterGroup, role: FacetRole, scaleOf: StoredUnitScaleOf = NO_MODEL): GroupFacets {
  const reasons: string[] = [];
  const notes = new Set<string>();
  if (group.rules.length === 0) {
    return { ok: false, reasons: [role === 'applicability' ? 'the applicability is empty' : 'the requirement has no conditions'] };
  }
  if (group.combinator === 'OR' && group.rules.length > 1) {
    reasons.push('conditions combined with OR cannot be expressed in IDS 1.0 (facets are always AND-ed)');
  }

  const facets: IDSFacet[] = [];
  for (const rule of group.rules) {
    if ((rule.kind === 'ifcType' || rule.kind === 'predefinedType') && rule.op === 'notIn') {
      reasons.push(`a negated condition ("notIn") cannot be expressed in IDS 1.0`);
    }
  }
  const entity = entityFacetOf(group.rules, role, reasons);
  if (entity) facets.push(entity);

  const byBoundsKey = new Map<string, IDSFacet>();
  for (const rule of group.rules) {
    if (rule.kind === 'ifcType' || rule.kind === 'predefinedType') continue;
    const mapped = mapRule(rule, scaleOf);
    if ('reason' in mapped) { reasons.push(mapped.reason); continue; }
    const astral = regexNote(rule);
    if (astral) notes.add(astral);
    const existing = mapped.boundsKey ? byBoundsKey.get(mapped.boundsKey) : undefined;
    const existingValue = existing ? facetValue(existing) : undefined;
    const newValue = facetValue(mapped.facet);
    if (existingValue?.type === 'bounds' && newValue?.type === 'bounds') {
      const clash = mergeBounds(existingValue, newValue);
      if (clash) reasons.push(clash);
      continue;
    }
    if (mapped.boundsKey) byBoundsKey.set(mapped.boundsKey, mapped.facet);
    facets.push(mapped.facet);
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, facets, notes: [...notes] };
}
