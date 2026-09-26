/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unified filter rule taxonomy.
 *
 * Ported from the Tauri-side `filter.rs` engine and consumed by the
 * in-memory path-B runtime evaluator (`filter-evaluate.ts`). The
 * discriminated-union shape lets the chip UI serialise any rule as a
 * JSON object with a `"kind"` discriminator, mirroring serde's tagged
 * enum encoding. We use `kind` rather than `type` because `type`
 * collides with the IFC `type` attribute name on element rows.
 */

import { type ModelTagOp } from './model-tag.js';
import { groupRule, type GroupRule } from './filter-group-rule.js';
import type { SubjectReadOptions } from './subject-read-options.js';
import { modelFactRule, type ModelFactRule } from './filter-model-fact.js';

import type {
  SetOp, StringOp, NumericOp, ValueOp, ClassificationOp, Combinator, ValueComparison, TextKind,
} from './filter-operator-types.js';
export type {
  SetOp, StringOp, NumericOp, ValueOp, ClassificationOp, Combinator, ValueComparison, TextKind,
} from './filter-operator-types.js';

// ── Rule discriminated union ──────────────────────────────────────────────────
export interface StoreyRule {
  kind: 'storey';
  values: string[];
  op: SetOp;
  /**
   * Optional exact storey identity, set only when the rule was mirrored
   * from a HierarchyPanel click (which holds the real `(modelId,
   * expressId)` of the storey the user selected). `IfcBuildingStorey.Name`
   * is optional and not unique — two distinct storeys, even within one
   * model, routinely share a Name (repeated "Level 1" across wings, or
   * federated buildings). When `refs` is present, the evaluator matches
   * an element's storey by this exact identity instead of by name, so
   * clicking one storey never silently pulls in a same-named sibling.
   * Undefined for manually authored/typed rules (the chip UI only offers
   * names to type against), which keep matching by name as before.
   */
  refs?: ReadonlyArray<{ modelId: string; expressId: number }>;
}

/** Match the loaded model that owns an element. Values use a durable source
 * fingerprint so saved filters survive the fresh runtime ids minted on reload. */
export interface ModelRule {
  kind: 'model';
  values: string[];
  op: SetOp;
}

/** Match the owning model by its user-facing MODEL TAGS (#4215). `tagIds` are ids
 * (stable across renames); an id that no longer exists is unresolved → matches nothing. */
export interface ModelTagRule {
  kind: 'modelTag';
  op: ModelTagOp;
  tagIds: string[];
}

export interface IfcTypeRule {
  kind: 'ifcType';
  values: string[];
  op: SetOp;
  /** Exact-class applicability, no subtype expansion (bSI #356, deferred by
   *  IDS to "Future 2.0+"). Default false/absent = today's behaviour
   *  (`values` already come pre-expanded through `expandTypes` at the
   *  chip/selector layer). Type-only here: the search evaluator
   *  (`filter-match.ts`) has no reason to read it, only the validation
   *  engine (#5138 PR 3) does. */
  exactClass?: boolean;
}

export interface PredefinedTypeRule {
  kind: 'predefinedType';
  values: string[];
  op: SetOp;
}

export interface NameRule {
  kind: 'name';
  op: StringOp;
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

/** `325Q7Fhnf67OZC$$r43uzK` / `! 325Q7Fhnf67OZC$$r43uzK` — one element, by
 *  GlobalId. Multi-valued like `ifcType`/`storey` so several bare-GlobalId
 *  terms (or a Ctrl-click accumulation) fold into one rule; matching is
 *  case-SENSITIVE (`values` are 22-character base64 IFC GlobalIds, where
 *  case is significant), unlike every other set-membership rule here. */
export interface GlobalIdRule {
  kind: 'globalId';
  values: string[];
  op: SetOp;
}

/**
 * `Description=Foo`, `ObjectType != NULL`, … — an IFC attribute other than
 * Name or PredefinedType, which each have their own rule kind. `name` is the
 * schema attribute name (matched case-insensitively against what the source
 * buffer's schema-driven extraction returns); a `GlobalId` name is rejected
 * at the selector adapter rather than reaching here — `extractAllEntityAttributes`
 * never surfaces it (it's a structural/display attribute the parser skips),
 * so routing it here would silently match nothing instead of finding the
 * element the bare-GlobalId term already exists to find.
 */
export interface AttributeRule {
  kind: 'attribute';
  name: string;
  op: ValueOp;
  /** Raw user input. Numeric ops parse as f64; isSet/isNotSet ignore. */
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
  comparison?: ValueComparison;
}

export interface PropertyRule extends SubjectReadOptions {
  kind: 'property';
  setName: string;
  /** How `setName` reads — a regex set name is what lets one rule reach both
   *  `Pset_WallCommon` and `Pset_SlabCommon`. */
  setNameKind?: TextKind;
  propertyName: string;
  /** How `propertyName` reads. */
  propertyNameKind?: TextKind;
  op: ValueOp;
  /** Raw user input. Numeric ops parse as f64; isSet/isNotSet ignore. */
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
  comparison?: ValueComparison;
}

export interface QuantityRule extends SubjectReadOptions {
  kind: 'quantity';
  setName: string;
  /** How `setName` reads. */
  setNameKind?: TextKind;
  quantityName: string;
  /** How `quantityName` reads. */
  quantityNameKind?: TextKind;
  op: NumericOp;
  value: number;
}

/** Match against an element's material name(s) — top-level material,
 *  layer / constituent / profile names, list members — AND Category (#4094).
 *  Multi-valued: the evaluator matches if ANY candidate satisfies a positive
 *  op, or NONE violates a negative op (ne / notContains). */
export interface MaterialRule {
  kind: 'material';
  op: StringOp;
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

/** Match against an element's classification references (e.g. Uniclass,
 *  OmniClass). `system` optionally scopes to one classification system;
 *  the value matches a reference's code (identification) OR name. */
export interface ClassificationRule {
  kind: 'classification';
  /** Optional system scope (e.g. "Uniclass 2015"). Empty = any system. */
  system?: string;
  op: ClassificationOp;
  /** Matched against identification (code) OR name. Ignored for isSet/isNotSet. */
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

/** Match against an element's elevation in metres — derived from the
 *  elevation of the building storey the element belongs to. */
export interface ElevationRule {
  kind: 'elevation';
  op: NumericOp;
  /** Threshold in metres. */
  value: number;
}

/**
 * `type=WT01` (IfcOpenShell selector syntax) — match against the Name of
 * the element's RELATING TYPE, reached via `IfcRelDefinesByType`. This is
 * a different dimension from {@link IfcTypeRule}, which matches the
 * element's own IFC *class* (`IfcWall`); `type=` instead matches the type
 * OBJECT's `Name` attribute (e.g. `IfcWallType.Name`, "WT01"). An element
 * with no `IfcRelDefinesByType` relation never matches. #4094.
 */
export interface TypeNameRule {
  kind: 'type';
  op: StringOp;
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

/** `parent=Foo` (#4903) — direct or indirect spatial-hierarchy child of an
 *  element named `Foo`; walks containment AND aggregation, any depth, via
 *  `@ifc-lite/data`'s shared `collectSpatialAncestors` (see
 *  `filter-match.ts`'s `matchParentRule`). Multi-valued like `material`:
 *  ANY ancestor Name matching a positive op, or NONE violating a negative
 *  one; no (matching) ancestors satisfies neither op — EMPTY, not "no filter". */
export interface ParentRule {
  kind: 'parent';
  op: StringOp;
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

export type FilterRule =
  | ModelRule
  | ModelTagRule
  | StoreyRule
  | IfcTypeRule
  | PredefinedTypeRule
  | NameRule
  | GlobalIdRule
  | AttributeRule
  | PropertyRule
  | QuantityRule
  | MaterialRule
  | ClassificationRule
  | ElevationRule
  | TypeNameRule
  | ParentRule
  | GroupRule | ModelFactRule;

// ── Combinator helpers ────────────────────────────────────────────────────────
/** Combine an array of per-rule booleans according to AND/OR semantics. */
export function combineRuleResults(combinator: Combinator, results: readonly boolean[]): boolean {
  if (results.length === 0) return false;
  return combinator === 'AND' ? results.every((r) => r) : results.some((r) => r);
}

/** Dedupe-merge two `StoreyRule.refs` lists by (modelId, expressId), used
 *  when a Ctrl-click accumulates another storey into an existing filter
 *  (HierarchyPanel). */
export function mergeStoreyRefs(
  prior: ReadonlyArray<{ modelId: string; expressId: number }>,
  next: ReadonlyArray<{ modelId: string; expressId: number }>,
): Array<{ modelId: string; expressId: number }> {
  const seen = new Set(prior.map((r) => `${r.modelId}:${r.expressId}`));
  const merged = [...prior];
  for (const r of next) {
    const key = `${r.modelId}:${r.expressId}`;
    if (!seen.has(key)) { seen.add(key); merged.push(r); }
  }
  return merged;
}

/** Add a HierarchyPanel storey click to its mirrored `op:in` rule.
 *
 * A rule created by the hierarchy carries exact refs. A manually authored
 * rule has no refs and deliberately matches by its names; changing that rule
 * to ref mode would discard every existing manual selection. Keep it in name
 * mode when extending it, while hierarchy-originated rules retain exact refs.
 */
export function addHierarchyStoreyToRule(
  prior: StoreyRule | undefined,
  name: string,
  refs: ReadonlyArray<{ modelId: string; expressId: number }>,
): StoreyRule {
  const values = Array.from(new Set([...(prior?.values ?? []), name]));
  if (prior && !prior.refs) return Rule.storey(values, 'in');
  return Rule.storey(values, 'in', mergeStoreyRefs(prior?.refs ?? [], refs));
}

// ── Convenience constructors ──────────────────────────────────────────────────
//
// The chip UI builds rules via `set*` slice actions (see searchSlice.ts);
// these helpers exist primarily for tests and for code paths that synthesize
// rules from a different representation (URL state, presets).

export const Rule = {
  model: (values: string[], op: SetOp = 'in'): ModelRule => ({ kind: 'model', values, op }),
  modelTag: (op: ModelTagOp, tagIds: string[]): ModelTagRule => ({ kind: 'modelTag', op, tagIds }),
  storey: (
    values: string[],
    op: SetOp = 'in',
    refs?: ReadonlyArray<{ modelId: string; expressId: number }>,
  ): StoreyRule => ({ kind: 'storey', values, op, ...(refs ? { refs } : {}) }),
  ifcType: (values: string[], op: SetOp = 'in'): IfcTypeRule => ({ kind: 'ifcType', values, op }),
  predefinedType: (values: string[], op: SetOp = 'in'): PredefinedTypeRule =>
    ({ kind: 'predefinedType', values, op }),
  name: (op: StringOp, value: string, valueKind?: TextKind): NameRule =>
    ({ kind: 'name', op, value, ...(valueKind ? { valueKind } : {}) }),
  globalId: (values: string[], op: SetOp = 'in'): GlobalIdRule => ({ kind: 'globalId', values, op }),
  attribute: (
    name: string,
    op: ValueOp,
    value: string,
    valueKind?: TextKind,
  ): AttributeRule => ({ kind: 'attribute', name, op, value, ...(valueKind ? { valueKind } : {}) }),
  property: (
    setName: string,
    propertyName: string,
    op: ValueOp,
    value: string,
    kinds: Pick<PropertyRule, 'setNameKind' | 'propertyNameKind' | 'valueKind'> = {},
  ): PropertyRule => ({ kind: 'property', setName, propertyName, op, value, ...kinds }),
  quantity: (
    setName: string,
    quantityName: string,
    op: NumericOp,
    value: number,
    kinds: Pick<QuantityRule, 'setNameKind' | 'quantityNameKind'> = {},
  ): QuantityRule => ({ kind: 'quantity', setName, quantityName, op, value, ...kinds }),
  material: (op: StringOp, value: string, valueKind?: TextKind): MaterialRule =>
    ({ kind: 'material', op, value, ...(valueKind ? { valueKind } : {}) }),
  classification: (
    system: string,
    op: ClassificationOp,
    value: string,
    valueKind?: TextKind,
  ): ClassificationRule =>
    ({ kind: 'classification', system: system || undefined, op, value, ...(valueKind ? { valueKind } : {}) }),
  elevation: (op: NumericOp, value: number): ElevationRule => ({ kind: 'elevation', op, value }),
  typeName: (op: StringOp, value: string, valueKind?: TextKind): TypeNameRule =>
    ({ kind: 'type', op, value, ...(valueKind ? { valueKind } : {}) }),
  parent: (op: StringOp, value: string, valueKind?: TextKind): ParentRule =>
    ({ kind: 'parent', op, value, ...(valueKind ? { valueKind } : {}) }),
  group: groupRule, modelFact: modelFactRule,
} as const;

// ── JSON guards (`filter-rule-guards.ts`, re-exported for existing imports) ─
export { isFilterRule, parseFilterRules } from './filter-rule-guards.js';
export type { GroupRule } from './filter-group-rule.js';
export type { ModelFactRule } from './filter-model-fact.js';
// Re-exported so existing `from './filter-rules.js'` imports (HierarchyPanel,
// etc.) can pull in the groups helper too without a second import line (#4904).
export { activeGroupRules } from './filter-groups.js';
