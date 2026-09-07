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

// ── Operator enums ────────────────────────────────────────────────────────────

/** Set-membership: storey, ifcType, predefinedType. */
export type SetOp = 'in' | 'notIn';

/** String comparisons (Name rule). */
export type StringOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'matches'
  | 'notMatches';

/** Numeric comparisons (Quantity rule). */
export type NumericOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** Mixed string+numeric+presence ops for Property values. */
export type ValueOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'notMatches'
  | 'isSet'
  | 'isNotSet';

/** Classification value+presence ops. A classification is matched against
 *  its code / name string, so this is the StringOp comparison subset plus
 *  presence — numeric ops don't apply. */
export type ClassificationOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'notMatches'
  | 'isSet'
  | 'isNotSet';

/** Top-level rule combinator. */
export type Combinator = 'AND' | 'OR';

/**
 * How a rule reads one of its strings — the producer saying so, because the
 * string itself cannot.
 *
 * `'regex'` is a regular-expression SOURCE: the WHOLE string is the pattern,
 * slashes included. `'literal'` is exact text that is never a pattern, however
 * it happens to be spelled. Absent means free text a human typed into a chip
 * field, which keeps the Lists-panel convention (#1591): a `/body/flags`
 * literal is a pattern, anything else is plain text.
 *
 * Guessing this back out of the text is the #4091 defect class — matched the
 * wrong thing, said nothing — reappearing at the adapter seam. The selector
 * grammar knows which it parsed: quoting is its ONLY escape hatch for a
 * literal name, so `"/Wall/".FireRating` is the plain name `/Wall/`, and
 * `Name=/\/tmp\//` is the source `/tmp/`. Sniffed for slashes, the first
 * matches every `…Wall…` set and the second matches `tmp`.
 *
 * A property-set or property NAME has no operator beside it, so both kinds
 * have to be declared. A VALUE's op already says whether it is a pattern, so
 * only `'regex'` is ever recorded there.
 */
export type TextKind = 'literal' | 'regex';


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

export interface IfcTypeRule {
  kind: 'ifcType';
  values: string[];
  op: SetOp;
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

export interface PropertyRule {
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
}

export interface QuantityRule {
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
 *  layer / constituent / profile names, and list members. Multi-valued:
 *  the evaluator matches if ANY name satisfies a positive op, or NONE
 *  violates a negative op (ne / notContains). */
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

export type FilterRule =
  | ModelRule
  | StoreyRule
  | IfcTypeRule
  | PredefinedTypeRule
  | NameRule
  | PropertyRule
  | QuantityRule
  | MaterialRule
  | ClassificationRule
  | ElevationRule;

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
} as const;

// ── JSON guards ──────────────────────────────────────────────────────────────

export function isFilterRule(value: unknown): value is FilterRule {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'model' ||
    kind === 'storey' ||
    kind === 'ifcType' ||
    kind === 'predefinedType' ||
    kind === 'name' ||
    kind === 'property' ||
    kind === 'quantity' ||
    kind === 'material' ||
    kind === 'classification' ||
    kind === 'elevation'
  );
}

export function parseFilterRules(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterRule);
}
