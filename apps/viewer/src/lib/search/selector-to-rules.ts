/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adapter: IfcOpenShell selector AST → the viewer's `FilterRule[]`.
 *
 * `parseSelector` (`@ifc-lite/query`) understands the whole grammar; this
 * turns the part of it the path-B evaluator can answer into rules, and names
 * every part it cannot in `unsupported`. Nothing is dropped quietly — a
 * selector that silently matched zero elements is the defect #4091 reported,
 * so a construct this adapter has no rule for has to come back as text the
 * user can read, with the original spelling they typed.
 *
 * The follow-up (#4094) adds the rule kinds and the union support that would
 * empty most of the `unsupported` list; a second adapter onto the CLI/MCP/SDK
 * query descriptor reads the same AST rather than a second grammar.
 */

import { expandTypes, isKnownType, normalizeIfcTypeName } from '@ifc-lite/parser';
import type {
  SelectorFilter,
  SelectorOp,
  SelectorQuery,
  SelectorText,
  SelectorValue,
} from '@ifc-lite/query';
import {
  Rule,
  type FilterRule,
  type NumericOp,
  type SetOp,
  type TextKind,
  type ValueOp,
} from './filter-rules.js';

/**
 * The comparison ops every string-ish dimension shares — Name, material and
 * classification alike. Deliberately narrower than `StringOp`: it omits
 * `startsWith`, which the grammar has no spelling for, and it is assignable to
 * `ClassificationOp` as well, so nothing here needs a cast.
 */
type SharedStringOp = 'eq' | 'ne' | 'contains' | 'notContains' | 'matches' | 'notMatches';

export interface SelectorAdaptOptions {
  /** The model's IFC schema, so class expansion picks the right subtype table. */
  schemaVersion?: string;
}

export interface SelectorAdaptResult {
  /** Filters within a group narrow left to right, which is the AND combinator. */
  combinator: 'AND';
  rules: FilterRule[];
  /** One entry per construct that produced no rule, quoting what was typed. */
  unsupported: string[];
}

/** `= != > >= < <= *= !*=` onto the property `ValueOp` set. */
const VALUE_OPS: Partial<Record<SelectorOp, ValueOp>> = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  '*=': 'contains', '!*=': 'notContains',
};

/** The subset that survives onto a string-only dimension (Name, material). */
const STRING_OPS: Partial<Record<SelectorOp, SharedStringOp>> = {
  '=': 'eq', '!=': 'ne', '*=': 'contains', '!*=': 'notContains',
};

const NUMERIC_OPS: Partial<Record<SelectorOp, NumericOp>> = {
  '=': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
};

/** A regex value only has a meaning for equality and its negation. */
const REGEX_OPS: Partial<Record<SelectorOp, 'matches' | 'notMatches'>> = {
  '=': 'matches', '!=': 'notMatches',
};

export function selectorToFilterRules(
  query: SelectorQuery,
  options: SelectorAdaptOptions = {},
): SelectorAdaptResult {
  const unsupported: string[] = [];
  const [group, ...extraGroups] = query.groups;

  for (const extra of extraGroups) {
    unsupported.push(
      `${quote(extra.filters.map((f) => f.text).join(', '))}: unioning groups with "+" is not supported yet, run it as a second filter`,
    );
  }

  const classAdds: string[] = [];
  const classSubtracts: string[] = [];
  const rules: FilterRule[] = [];

  for (const filter of group?.filters ?? []) {
    if (filter.kind === 'class') {
      if (!isKnownType(filter.name)) {
        unsupported.push(`${quote(filter.name)}: not an entity name in IFC2X3, IFC4 or IFC4X3`);
        continue;
      }
      (filter.negate ? classSubtracts : classAdds).push(filter.name);
      continue;
    }
    const adapted = adaptFilter(filter);
    if (typeof adapted === 'string') unsupported.push(adapted);
    else rules.push(adapted);
  }

  const head: FilterRule[] = [];
  if (classAdds.length > 0) head.push(Rule.ifcType(expandClasses(classAdds, options), 'in'));
  if (classSubtracts.length > 0) head.push(Rule.ifcType(expandClasses(classSubtracts, options), 'notIn'));

  return { combinator: 'AND', rules: [...head, ...rules], unsupported };
}

/**
 * A class names its subclasses too, which is the whole difference between
 * `IfcWall` here and `IfcWall` in the chip dropdown: `expandTypes` walks the
 * schema's subtype table, so `IfcWall` reaches `IfcWallStandardCase` and
 * `IfcElement` reaches all 180 of its descendants. It answers in the STEP
 * file's UPPERCASE spelling; matching folds case either way, but the chips
 * show these values, so they are normalised back to PascalCase.
 */
function expandClasses(names: string[], options: SelectorAdaptOptions): string[] {
  return expandTypes(names, options.schemaVersion).map(normalizeIfcTypeName);
}

/** One non-class filter: a rule, or the sentence explaining why there isn't one. */
function adaptFilter(filter: SelectorFilter): FilterRule | string {
  switch (filter.kind) {
    case 'globalId':
      return `${quote(filter.text)}: GlobalId terms are not supported yet, search for the GlobalId instead (#4094)`;
    case 'attribute':
      return adaptAttribute(filter.name, filter.op, filter.value, filter.text);
    case 'property':
      return adaptProperty(filter.pset, filter.prop, filter.op, filter.value, filter.text);
    case 'material':
      return adaptMaterial(filter.op, filter.value, filter.text);
    case 'classification':
      return adaptClassification(filter.op, filter.value, filter.text);
    case 'location':
      return adaptLocation(filter.op, filter.value, filter.text);
    case 'type':
      return `${quote(filter.text)}: matching an element's type by name is not supported yet (#4094)`;
    case 'parent':
      return `${quote(filter.text)}: "parent=" is not supported`;
    case 'query':
      return `${quote(filter.text)}: "query:" value queries are not supported`;
    case 'class':
      // Folded into the ifcType rules by the caller; unreachable here.
      return `${quote(filter.text)}: unexpected class filter`;
  }
}

function adaptAttribute(
  name: string,
  op: SelectorOp,
  value: SelectorValue,
  text: string,
): FilterRule | string {
  const attribute = name.toLowerCase();
  if (attribute !== 'name' && attribute !== 'predefinedtype') {
    return `${quote(text)}: only the Name and PredefinedType attributes are filterable (#4094)`;
  }
  if (value.kind === 'null') return `${quote(text)}: an attribute cannot be compared to NULL`;

  if (attribute === 'predefinedtype') {
    const setOp = setOpFor(op);
    if (!setOp) return `${quote(text)}: PredefinedType takes only "=" and "!="`;
    if (value.kind === 'regex') return `${quote(text)}: PredefinedType cannot be matched by a regular expression`;
    return Rule.predefinedType([value.text], setOp);
  }

  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  return Rule.name(stringOp, literalOf(value), regexValueKind(value));
}

function adaptProperty(
  pset: SelectorText,
  prop: SelectorText,
  op: SelectorOp,
  value: SelectorValue,
  text: string,
): FilterRule | string {
  for (const part of [pset, prop]) {
    const invalid = regexProblem(part);
    if (invalid) return `${quote(text)}: ${invalid}`;
  }
  const setName = literalOf(pset);
  const propName = literalOf(prop);
  const names = { setNameKind: nameKind(pset), propertyNameKind: nameKind(prop) };

  if (value.kind === 'null') {
    if (op === '=') return Rule.property(setName, propName, 'isNotSet', '', names);
    if (op === '!=') return Rule.property(setName, propName, 'isSet', '', names);
    return `${quote(text)}: NULL can only be compared with "=" or "!="`;
  }

  if (value.kind === 'regex') {
    const regexOp = REGEX_OPS[op];
    if (!regexOp) return unsupportedOp(text, op, value);
    const invalid = regexProblem(value);
    if (invalid) return `${quote(text)}: ${invalid}`;
    return Rule.property(setName, propName, regexOp, value.source, { ...names, valueKind: 'regex' });
  }

  const numeric = Number.parseFloat(value.text);
  const numericOp = NUMERIC_OPS[op];
  if (looksLikeQuantitySet(pset) && numericOp && Number.isFinite(numeric) && value.text.trim() !== '') {
    return Rule.quantity(setName, propName, numericOp, numeric, {
      setNameKind: names.setNameKind,
      quantityNameKind: names.propertyNameKind,
    });
  }

  const valueOp = VALUE_OPS[op];
  if (!valueOp) return unsupportedOp(text, op, value);
  return Rule.property(setName, propName, valueOp, value.text, names);
}

function adaptMaterial(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind === 'null') return `${quote(text)}: "material=" cannot be compared to NULL`;
  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  // Matched against each material NAME the element exposes. IfcOpenShell also
  // accepts a material Category here; ifc-lite does not read Category yet
  // (#4094), so a Category-only match still finds nothing — stated in the docs
  // rather than silently approximated.
  return Rule.material(stringOp, literalOf(value), regexValueKind(value));
}

function adaptClassification(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind === 'null') {
    if (op === '=') return Rule.classification('', 'isNotSet', '');
    if (op === '!=') return Rule.classification('', 'isSet', '');
    return `${quote(text)}: NULL can only be compared with "=" or "!="`;
  }
  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  return Rule.classification('', stringOp, literalOf(value), regexValueKind(value));
}

function adaptLocation(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind !== 'string') {
    return `${quote(text)}: "location=" takes a plain storey name, not a regular expression or NULL`;
  }
  const setOp = setOpFor(op);
  if (!setOp) return `${quote(text)}: "location=" takes only "=" and "!="`;
  // Storey NAME only, and only for elements the storey contains directly (or
  // their aggregated parts) — measured in `filter-evaluate.test.ts`. An element
  // inside a space on that storey does NOT match, which is where this differs
  // from IfcOpenShell's "directly or indirectly" (#4094).
  return Rule.storey([value.text], setOp);
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function setOpFor(op: SelectorOp): SetOp | undefined {
  if (op === '=') return 'in';
  if (op === '!=') return 'notIn';
  return undefined;
}

function stringOpFor(op: SelectorOp, value: SelectorValue): SharedStringOp | undefined {
  return value.kind === 'regex' ? REGEX_OPS[op] : STRING_OPS[op];
}

/** The bare text of a name or operand: a regex travels as its own source. */
function literalOf(value: SelectorText): string {
  return value.kind === 'regex' ? value.source : value.text;
}

/**
 * A property-set or property NAME's kind, handed to the rule instead of being
 * re-encoded into a spelling the matcher has to guess back out. A name has no
 * operator beside it, so BOTH kinds have to be stated.
 *
 * Re-encoding was the #4091 defect class at this seam. A quoted name is the
 * grammar's only way to ask for a LITERAL, so `"/Wall/".FireRating` written
 * back as `/Wall/` became a pattern matching `Pset_WallCommon`; and a regex
 * source can itself start and end with a slash, so `Name=/\/tmp\//` written
 * back bare became the pattern `tmp`. Both matched the wrong elements and
 * said nothing.
 */
function nameKind(name: SelectorText): TextKind {
  return name.kind === 'regex' ? 'regex' : 'literal';
}

/**
 * The same discriminator for a comparison OPERAND, where only one half needs
 * saying: a value reaches a regex op only by having been written as `/…/`, so
 * a rule with no `valueKind` is one whose op already rules a pattern out.
 */
function regexValueKind(value: SelectorText): TextKind | undefined {
  return value.kind === 'regex' ? 'regex' : undefined;
}

/**
 * A `/…/` that JavaScript cannot compile, reported here rather than at match
 * time. `stringOpMatches` treats an uncompilable pattern as "matches nothing",
 * which is indistinguishable from a correct pattern with no hits — the shape
 * this whole change exists to remove.
 */
function regexProblem(value: SelectorText | SelectorValue): string | undefined {
  if (value.kind !== 'regex') return undefined;
  try {
    new RegExp(value.source);
    return undefined;
  } catch (err) {
    return `/${value.source}/ is not a valid regular expression: ${(err as Error).message}`;
  }
}

/** A set the quantity rule owns: `Qto_WallBaseQuantities`, or a regex over it. */
function looksLikeQuantitySet(pset: SelectorText): boolean {
  const text = pset.kind === 'regex' ? pset.source.replace(/^\^/, '') : pset.text;
  return text.toLowerCase().startsWith('qto_');
}

function unsupportedOp(text: string, op: SelectorOp, value: SelectorValue): string {
  const shape = value.kind === 'regex' ? 'a regular expression' : 'this value';
  return `${quote(text)}: "${op}" is not supported against ${shape} here`;
}

function quote(text: string): string {
  return JSON.stringify(text);
}
