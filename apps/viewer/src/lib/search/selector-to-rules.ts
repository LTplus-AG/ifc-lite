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
import { parseSelector } from '@ifc-lite/query';
import type {
  SelectorFilter,
  SelectorOp,
  SelectorParseError,
  SelectorQuery,
  SelectorText,
  SelectorValue,
} from '@ifc-lite/query';
import { Rule, type FilterRule } from './filter-rules.js';
import {
  VALUE_OPS,
  NUMERIC_OPS,
  FILTERABLE_ATTRIBUTES,
  REGEX_OPS,
  setOpFor,
  stringOpFor,
  literalOf,
  nameKind,
  regexValueKind,
  regexProblem,
  looksLikeQuantitySet,
  quantityNeedsNumber,
  unsupportedOp,
  quote,
} from './selector-adapt-helpers.js';

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
  /** No rule came out and every term is an unknown class or a non-filterable
   *  attribute — what a plain search term (`IFC-Export`, `Level=1`) parses
   *  into. A caller holding a free-text fallback keeps it here. */
  readsAsPlainText: boolean;
}

/** A parse that failed, or a parse that was adapted. */
export type SelectorReading =
  | { ok: false; error: SelectorParseError }
  | ({ ok: true } & SelectorAdaptResult);

/**
 * Selector text as filter rules: parse, then adapt, in one call.
 *
 * Both surfaces that accept selector text — the Filter tab's Selector field
 * and its "add the search query as a rule" button — go through here, so the
 * two cannot read the same string differently. What each does with the answer
 * is deliberately NOT shared: one replaces the rule list and one appends to
 * it, and only the caller knows which.
 */
export function readSelector(text: string, options: SelectorAdaptOptions = {}): SelectorReading {
  const parsed = parseSelector(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, ...selectorToFilterRules(parsed.query, options) };
}

/** Text reading as a selector the Filter tab can RUN. An unknown class or a bare
 *  GlobalId parses but yields no rule, so parsing alone is the wrong hint (#4091). */
export function selectorYieldsRules(text: string): boolean {
  const reading = readSelector(text);
  return reading.ok && reading.rules.length > 0;
}

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
  const classAddTexts: string[] = [];
  const classSubtracts: string[] = [];
  // Bare GlobalId terms are additive facets too, per IfcOpenShell's
  // `instance()`: `325Q7…` ADDS an element by id and `! 325Q7…` REMOVES one,
  // so several of them in one group union (add) or subtract (remove) rather
  // than each narrowing the result on its own — the same shape `classAdds`
  // already folds several class names into one `in` rule for.
  const globalIdAdds: string[] = [];
  const globalIdAddTexts: string[] = [];
  const globalIdSubtracts: string[] = [];
  const rules: FilterRule[] = [];

  for (const filter of group?.filters ?? []) {
    if (filter.kind === 'class') {
      if (!isKnownType(filter.name)) {
        unsupported.push(`${quote(filter.text)}: not an entity name in IFC2X3, IFC4 or IFC4X3`);
        continue;
      }
      if (filter.negate) classSubtracts.push(filter.name);
      else {
        classAdds.push(filter.name);
        classAddTexts.push(filter.text);
      }
      continue;
    }
    if (filter.kind === 'globalId') {
      if (filter.negate) globalIdSubtracts.push(filter.id);
      else {
        globalIdAdds.push(filter.id);
        globalIdAddTexts.push(filter.text);
      }
      continue;
    }
    const adapted = adaptFilter(filter);
    if (typeof adapted === 'string') unsupported.push(adapted);
    else rules.push(adapted);
  }

  const head: FilterRule[] = [];
  // `IfcWall, 325Q7…` reads as "walls OR that element" upstream — `entity()`
  // and `instance()` both `|=` into the same accumulator (see the file
  // header) — but this adapter's rule model is AND-only, so a class ADD and
  // a GlobalId ADD sharing a group cannot be expressed as one AND rule
  // without silently narrowing to their intersection instead of their union
  // (a GUID naming a door would then match nothing under `IfcWall, <GUID>`).
  // Report it rather than guess, the same defensive call this file already
  // makes for `+` group unions. The negated form (`! 325Q7…`) stays exact:
  // it subtracts from whatever the class ADD already produced, which is the
  // same set an AND + `notIn` rule narrows to.
  if (classAdds.length > 0 && globalIdAdds.length > 0) {
    unsupported.push(
      `${quote([...classAddTexts, ...globalIdAddTexts].join(', '))}: a class and a GlobalId here both add elements rather than narrow (IfcOpenShell unions additive facets), so this cannot be expressed as one AND filter — run the class and the GlobalId as two separate filters`,
    );
  } else {
    if (classAdds.length > 0) head.push(Rule.ifcType(expandClasses(classAdds, options), 'in'));
    if (globalIdAdds.length > 0) head.push(Rule.globalId(globalIdAdds, 'in'));
  }
  if (classSubtracts.length > 0) head.push(Rule.ifcType(expandClasses(classSubtracts, options), 'notIn'));
  if (globalIdSubtracts.length > 0) head.push(Rule.globalId(globalIdSubtracts, 'notIn'));

  const all = [...head, ...rules];
  const readsAsPlainText = all.length === 0 && extraGroups.length === 0 && (group?.filters ?? []).every(isPlainTextTerm);
  return { combinator: 'AND', rules: all, unsupported, readsAsPlainText };
}

/** A term carrying nothing selector-specific: a class name no schema knows
 *  (`IFC-Export`), or the one attribute comparison with no rule behind it
 *  (`GlobalId=x` — every other attribute name is now a generic `attribute`
 *  rule, #4094). Text made only of these is a search term that happens to
 *  parse. */
function isPlainTextTerm(filter: SelectorFilter): boolean {
  if (filter.kind === 'class') return !isKnownType(filter.name);
  return filter.kind === 'attribute' && filter.name.toLowerCase() === 'globalid';
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
      // Folded into the globalId rules by the caller; unreachable here.
      return `${quote(filter.text)}: unexpected GlobalId filter`;
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

  if (attribute === 'globalid') {
    // A real IFC attribute, but the schema-driven on-demand extraction
    // (`extractAllEntityAttributes`) deliberately skips GlobalId as a
    // structural/display attribute — it never appears in the rows an
    // `attribute` rule reads. Routing it there would silently match
    // nothing, exactly the #4091 defect class this whole adapter exists to
    // avoid. The bare-GlobalId literal term already exists to find an
    // element by id; `GlobalId=` written as a comparison stays unsupported.
    return `${quote(text)}: "GlobalId=" is not supported, use a bare GlobalId term instead (#4094)`;
  }

  if (FILTERABLE_ATTRIBUTES.has(attribute)) {
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

  // A generic attribute — Description, ObjectType, Tag, LongName, or any
  // other schema-named attribute `extractAllEntityAttributes` surfaces
  // (#4094). Mirrors `adaptProperty`'s non-quantity branch: NULL becomes a
  // presence check, a `/…/` value takes only "=" / "!=", and everything
  // else maps through the same `ValueOp` set a property term uses.
  if (value.kind === 'null') {
    if (op === '=') return Rule.attribute(name, 'isNotSet', '');
    if (op === '!=') return Rule.attribute(name, 'isSet', '');
    return `${quote(text)}: NULL can only be compared with "=" or "!="`;
  }
  if (value.kind === 'regex') {
    const regexOp = REGEX_OPS[op];
    if (!regexOp) return unsupportedOp(text, op, value);
    const invalid = regexProblem(value);
    if (invalid) return `${quote(text)}: ${invalid}`;
    return Rule.attribute(name, regexOp, value.source, 'regex');
  }
  const valueOp = VALUE_OPS[op];
  if (!valueOp) return unsupportedOp(text, op, value);
  return Rule.attribute(name, valueOp, value.text);
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

  // A `Qto_` set names the QUANTITY table, which a property rule does not read,
  // so a term the quantity rule cannot carry is reported rather than aimed at
  // rows it can never find — `Qto_….NetVolume=NULL` matched EVERY element
  // (#4091). Property rules reading quantity rows is #4094.
  const quantitySet = looksLikeQuantitySet(pset);

  if (value.kind === 'null') {
    if (quantitySet) return quantityNeedsNumber(text);
    if (op === '=') return Rule.property(setName, propName, 'isNotSet', '', names);
    if (op === '!=') return Rule.property(setName, propName, 'isSet', '', names);
    return `${quote(text)}: NULL can only be compared with "=" or "!="`;
  }

  if (value.kind === 'regex') {
    if (quantitySet) return quantityNeedsNumber(text);
    const regexOp = REGEX_OPS[op];
    if (!regexOp) return unsupportedOp(text, op, value);
    const invalid = regexProblem(value);
    if (invalid) return `${quote(text)}: ${invalid}`;
    return Rule.property(setName, propName, regexOp, value.source, { ...names, valueKind: 'regex' });
  }

  if (quantitySet) {
    const numeric = Number.parseFloat(value.text);
    const numericOp = NUMERIC_OPS[op];
    if (!numericOp || !Number.isFinite(numeric)) return quantityNeedsNumber(text);
    const kinds = { setNameKind: names.setNameKind, quantityNameKind: names.propertyNameKind };
    return Rule.quantity(setName, propName, numericOp, numeric, kinds);
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

