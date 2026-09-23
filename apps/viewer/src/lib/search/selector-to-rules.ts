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
 * `+` unions (`IfcSlab + IfcDoor`) adapt into real `FilterGroup[]` — one
 * group per `+`-separated clause, OR'd together, AND within each group —
 * rather than being desugared into several searches unioned in UI glue
 * (#4904); see `SelectorAdaptResult.groups`. A second adapter onto the
 * CLI/MCP/SDK query descriptor reads the same AST rather than a second
 * grammar (#4094).
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
import { Rule, type FilterRule } from '@ifc-lite/rules';
import { type FilterGroup } from '@ifc-lite/rules';
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
import { adaptMaterial, adaptClassification, adaptLocation, adaptTypeName, adaptParent } from './selector-adapt-keywords.js';

export interface SelectorAdaptOptions {
  /** The model's IFC schema, so class expansion picks the right subtype table. */
  schemaVersion?: string;
}

export interface SelectorAdaptResult {
  /**
   * One `FilterGroup` per `+`-separated group in the selector text (#4904).
   * Groups OR together; each group's own filters narrow left to right, the
   * AND combinator. Length 1 for the (overwhelmingly common) union-free case.
   * Empty when the query was refused — see `unsupported`.
   */
  groups: FilterGroup[];
  /**
   * Convenience alias for `groups[0]?.rules ?? []` — the first group, AND
   * combinator. For callers that only ever edit ONE active group (the
   * "add search query as a rule" button appends into whichever group is
   * currently open in the builder) and were written before groups existed;
   * a caller that needs the real union reads `groups` instead.
   */
  rules: FilterRule[];
  /** Filters within a group narrow left to right, which is the AND combinator. */
  combinator: 'AND';
  /**
   * One entry per construct that produced no rule, quoting what was typed.
   * When the selector used `+` (more than one group) and ANY group has an
   * unsupported construct, the WHOLE query is refused — `groups` and `rules`
   * come back empty — rather than silently dropping that OR branch: an
   * omitted branch of a union changes what it matches exactly as much as an
   * omitted AND term would, and a union has no single-group warning banner
   * precedent to fall back on.
   */
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
  const perGroup = query.groups.map((g) => adaptOneGroup(g.filters, options));
  const isUnion = query.groups.length > 1;

  // A `+` union refuses the WHOLE query when any branch has an unsupported
  // construct — see the `unsupported` doc on `SelectorAdaptResult`. A
  // single group keeps the pre-#4904 behaviour: apply what adapted, name
  // the rest.
  if (isUnion && perGroup.some((g) => g.unsupported.length > 0)) {
    const unsupported = perGroup.flatMap((g, i) =>
      g.unsupported.map((u) => `group ${i + 1} of ${perGroup.length}: ${u}`),
    );
    return { groups: [], rules: [], combinator: 'AND', unsupported, readsAsPlainText: false };
  }

  const groups: FilterGroup[] = perGroup
    .filter((g) => g.rules.length > 0)
    .map((g) => ({ rules: g.rules, combinator: 'AND' as const }));
  const unsupported = perGroup.flatMap((g) => g.unsupported);
  const readsAsPlainText =
    groups.length === 0 &&
    !isUnion &&
    (query.groups[0]?.filters ?? []).every(isPlainTextTerm);

  return {
    groups,
    rules: groups[0]?.rules ?? [],
    combinator: 'AND',
    unsupported,
    readsAsPlainText,
  };
}

/** Adapt one `+`-separated group's filters into an AND rule list, naming
 *  every construct that did not produce a rule. Pulled out of
 *  `selectorToFilterRules` so it can run once per group (#4904) instead of
 *  only ever reading `query.groups[0]`. */
function adaptOneGroup(
  filters: readonly SelectorFilter[],
  options: SelectorAdaptOptions,
): { rules: FilterRule[]; unsupported: string[] } {
  const unsupported: string[] = [];
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

  for (const filter of filters) {
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

  return { rules: [...head, ...rules], unsupported };
}

/** A term carrying nothing selector-specific: a class name no schema knows
 *  (`IFC-Export`), or a GlobalId attribute comparison (`adaptAttribute`
 *  routes `=` / `!=` against a literal id onto a `globalId` rule, but every
 *  other GlobalId comparison — `*=`, `>`, a regex — stays without one, #4094).
 *  This predicate only decides `readsAsPlainText`, which is only consulted
 *  when NO filter in the group produced a rule; a `=`/`!=` GlobalId term
 *  always does, so this branch is reached only by the comparisons that
 *  don't, regardless of which way it answers for the ones that do. Text made
 *  only of these is a search term that happens to parse. */
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
      return adaptTypeName(filter.op, filter.value, filter.text);
    case 'parent':
      return adaptParent(filter.op, filter.value, filter.text);
    case 'query':
      // Deliberately refused permanently (#4094 maintainer decision): an
      // open key-path grammar, not one bounded rule to interpret.
      return `${quote(filter.text)}: "query:" value queries are deliberately out of scope — see docs/guide/selector-syntax.md`;
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
    // avoid. Instead this reuses `Rule.globalId` — the exact-identity, exact
    // set-membership rule the bare-GlobalId literal term already builds —
    // rather than re-deriving a second GlobalId matcher: `GlobalId=X` is
    // "find this one element by id" spelled as a comparison, and `!=` is its
    // negation, the same `notIn` the bare term's `! <id>` form already uses.
    // A GlobalId is a fixed 22-character identity, not text to search within
    // or order, so `*=`, `>`/`>=`/`<`/`<=`, a `/…/` value and `NULL` carry no
    // meaning `globalIdOpMatches` can express and stay refused by name.
    if (value.kind === 'string' && (op === '=' || op === '!=')) {
      return Rule.globalId([value.text], op === '=' ? 'in' : 'notIn');
    }
    return `${quote(text)}: "GlobalId" takes only "=" or "!=" against a literal id, use a bare GlobalId term instead (#4094)`;
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
