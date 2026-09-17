/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `adapt*` functions for the AST's `SelectorKeywordKind` terms — `material=`,
 * `classification=`, `location=`, `type=`, `parent=`. Split out of
 * `selector-to-rules.ts` (which keeps the group-level orchestration and the
 * attribute/property adapters) to stay under the module size cap, the same
 * reason `selector-adapt-helpers.ts` already exists as a sibling file.
 */

import type { SelectorOp, SelectorValue } from '@ifc-lite/query';
import { Rule, type FilterRule } from './filter-rules.js';
import {
  setOpFor,
  stringOpFor,
  literalOf,
  regexValueKind,
  regexProblem,
  unsupportedOp,
  quote,
} from './selector-adapt-helpers.js';

export function adaptMaterial(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind === 'null') return `${quote(text)}: "material=" cannot be compared to NULL`;
  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  // `filter-evaluate.ts` unions every material Name and Category into one
  // candidate set, matching IfcOpenShell's `material=` without changing this
  // adapter's rule shape (#4094).
  return Rule.material(stringOp, literalOf(value), regexValueKind(value));
}

export function adaptClassification(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
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

export function adaptLocation(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind !== 'string') {
    return `${quote(text)}: "location=" takes a plain storey name, not a regular expression or NULL`;
  }
  const setOp = setOpFor(op);
  if (!setOp) return `${quote(text)}: "location=" takes only "=" and "!="`;
  // Storey NAME. Includes direct elements, aggregated parts, and one hop
  // through a containing IfcSpace / IfcSpatialZone; the widening is in the
  // evaluator/prefilter, not this rule shape. Measured in
  // `filter-evaluate.test.ts`; nested spaces do not extend the reach.
  return Rule.storey([value.text], setOp);
}

/**
 * `type=WT01` — matches the RELATING TYPE's Name via `IfcRelDefinesByType`
 * (`Rule.typeName` / `filter-evaluate.ts`'s `relatingTypeNameOf`), not the
 * element's own IFC class (that's `IfcTypeRule`, built from a bare class
 * term like `IfcWall`). Mirrors `adaptMaterial`: NULL is rejected (a type
 * name is either the string on the relating type or the term reports
 * nothing, the same "cannot be compared to NULL" the material dimension
 * uses, rather than reusing the property-rule NULL→isSet/isNotSet
 * convention, since a bare `type=` filter — unlike a pset property — is
 * about a single positive string, not an optional field).
 */
export function adaptTypeName(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind === 'null') return `${quote(text)}: "type=" cannot be compared to NULL`;
  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  return Rule.typeName(stringOp, literalOf(value), regexValueKind(value));
}

/**
 * `parent=Foo` (#4903) — direct or indirect child, in the spatial hierarchy,
 * of an element whose `Name` is `Foo`. The multi-hop ancestor walk lives in
 * `filter-match.ts`'s `matchParentRule` over `@ifc-lite/data`'s shared
 * `collectSpatialAncestors`; this only shapes the comparison, same as
 * `adaptTypeName`/`adaptMaterial` for their own dimensions — NULL rejected,
 * bare/regex `=`, `!=`, `*=`/`!*=`.
 */
export function adaptParent(op: SelectorOp, value: SelectorValue, text: string): FilterRule | string {
  if (value.kind === 'null') return `${quote(text)}: "parent=" cannot be compared to NULL`;
  const stringOp = stringOpFor(op, value);
  if (!stringOp) return unsupportedOp(text, op, value);
  const invalid = regexProblem(value);
  if (invalid) return `${quote(text)}: ${invalid}`;
  return Rule.parent(stringOp, literalOf(value), regexValueKind(value));
}
