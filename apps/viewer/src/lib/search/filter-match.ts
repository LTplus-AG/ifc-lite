/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-rule value resolution + matching for the path-B evaluator.
 *
 * Split out of `filter-evaluate.ts` (which keeps the iteration /
 * orchestration logic) to stay under the module size cap. These helpers
 * are pure given their inputs, which is what makes them unit-testable in
 * `filter-evaluate.test.ts` via the evaluator's `__internal` re-export.
 */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
  type MaterialInfo,
  type ClassificationInfo,
} from '@ifc-lite/parser';

import {
  type PropertyRule,
  type QuantityRule,
  type ClassificationRule,
  type AttributeRule,
  type StoreyRule,
  type TextKind,
} from './filter-rules.js';
import { valueOpMatches, numericOpMatches, matchStringAnyNone } from './filter-ops.js';
import { lensMaterialNames } from '../lens-material-names.js';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { compileNameMatcher, isNamePattern } from '@ifc-lite/lists';

/**
 * Compare a rule's property-set / property name against a row's.
 *
 * `kind` is the rule saying what it holds (see {@link TextKind}). A `'regex'`
 * name is a SOURCE and the whole string is the pattern, which is what makes
 * the selector syntax's `/Pset_.*Common/.FireRating` reach `Pset_WallCommon`
 * and `Pset_SlabCommon` in one rule; a `'literal'` name is compared as text
 * even when it is spelled with slashes, which is what the grammar's quoting
 * means and the only reason `"/Wall/".FireRating` can be asked for at all.
 *
 * A name with no declared kind was typed into a chip field, where the
 * Lists-panel `/…/` convention (#1591) is the user's only way to say
 * "pattern"; anything else there is the historical case-insensitive equality.
 *
 * `compileNameMatcher` throws when the regex body is syntactically valid but
 * rejected by `@ifc-lite/regex-guard` as unsafe (catastrophic-backtracking
 * shaped, or over the length cap) — see `filter-ops.ts`'s `regexOpMatches`
 * docstring for the full contract. This function does not catch that; it
 * propagates to `filter-evaluate.ts`'s caller, which must.
 */
export function nameMatches(rulePattern: string, rowName: string, kind?: TextKind): boolean {
  if (kind === 'regex') return compileNameMatcher(`/${rulePattern}/`)(rowName);
  if (kind === undefined && isNamePattern(rulePattern)) return compileNameMatcher(rulePattern)(rowName);
  return rowName.toLowerCase() === rulePattern.toLowerCase();
}

// ── Pset / Qto matching ──────────────────────────────────────────────────────

export interface PsetRow { setName: string; propertyName: string; value: string }
export type PsetRows = ReadonlyArray<PsetRow>;

export interface QtyRow { setName: string; quantityName: string; value: number }
export type QtyRows = ReadonlyArray<QtyRow>;

export function flattenPsets(
  psets: ReturnType<typeof extractPropertiesOnDemand>,
): PsetRows {
  const out: PsetRow[] = [];
  for (const set of psets) {
    for (const p of set.properties) {
      out.push({
        setName: set.name,
        propertyName: p.name,
        // Stringify everything — `valueOpMatches` re-parses numeric ops
        // from this representation. Booleans render as "True"/"False" —
        // the SAME capitalised display string the property table and the
        // list engine (`@ifc-lite/encoding`'s `parsePropertyValue`) show —
        // so a value picked from a chip/dropdown suggestion always matches
        // what the user sees rendered elsewhere. `valueOpMatches`'s eq/ne
        // are case-insensitive, so this doesn't change matching outcomes
        // for either the search chips or free-typed "true"/"false".
        value: stringifyValue(p.value),
      });
    }
  }
  return out;
}

export function flattenQtys(
  qtos: ReturnType<typeof extractQuantitiesOnDemand>,
): QtyRows {
  const out: QtyRow[] = [];
  for (const set of qtos) {
    for (const q of set.quantities) {
      out.push({ setName: set.name, quantityName: q.name, value: q.value });
    }
  }
  return out;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Match `parsePropertyValue`'s boolean rendering ("True"/"False") — the
  // SAME function the property table and the list engine's display use —
  // so discovered dropdown suggestions equal what's actually shown/matched
  // elsewhere (#IsExternal true/false mismatch report).
  if (typeof value === 'boolean') return parsePropertyValue(value).displayValue;
  if (typeof value === 'number') return String(value);
  return String(value);
}

export function matchPropertyRule(rule: PropertyRule, rows: PsetRows): boolean {
  // isSet / isNotSet are presence checks against (setName, propertyName).
  if (rule.op === 'isSet' || rule.op === 'isNotSet') {
    const present = rows.some(
      (r) =>
        nameMatches(rule.setName, r.setName, rule.setNameKind) &&
        nameMatches(rule.propertyName, r.propertyName, rule.propertyNameKind),
    );
    return rule.op === 'isSet' ? present : !present;
  }

  return rows.some(
    (r) =>
      nameMatches(rule.setName, r.setName, rule.setNameKind) &&
      nameMatches(rule.propertyName, r.propertyName, rule.propertyNameKind) &&
      valueOpMatches(rule.op, r.value, rule.value, rule.valueKind),
  );
}

/** One entity's generic named attributes, as `extractAllEntityAttributes`
 *  returns them — schema-driven, string/number/boolean values only. */
export type AttrRows = ReadonlyArray<{ name: string; value: string | number | boolean }>;

/**
 * Match an `attribute` rule (Description, ObjectType, Tag, LongName, any
 * other schema-named attribute) against one entity's extracted attributes.
 * Attribute NAME matching is case-insensitive, same as the IDS attribute
 * facet this reuses the extraction from; the VALUE comparison reuses
 * `valueOpMatches`, the same comparator `matchPropertyRule` uses, so a
 * numeric attribute value compares the same way a numeric property does.
 */
export function matchAttributeRule(rule: AttributeRule, attrs: AttrRows): boolean {
  const wanted = rule.name.toLowerCase();
  const found = attrs.find((a) => a.name.toLowerCase() === wanted);
  const stringified = found === undefined ? undefined : stringifyValue(found.value);

  if (rule.op === 'isSet' || rule.op === 'isNotSet') {
    const present = (stringified ?? '').length > 0;
    return rule.op === 'isSet' ? present : !present;
  }
  if (stringified === undefined) return false;
  return valueOpMatches(rule.op, stringified, rule.value, rule.valueKind);
}

export function matchQuantityRule(rule: QuantityRule, rows: QtyRows): boolean {
  return rows.some(
    (r) =>
      nameMatches(rule.setName, r.setName, rule.setNameKind) &&
      nameMatches(rule.quantityName, r.quantityName, rule.quantityNameKind) &&
      numericOpMatches(rule.op, r.value, rule.value),
  );
}

// ── Storey lookup fallback ────────────────────────────────────────────────────

export function defaultStoreyName(store: IfcDataStore, expressId: number): string {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return '';
  const storeyId = hierarchy.elementToStorey.get(expressId);
  if (!storeyId) return '';
  return store.entities.getName(storeyId);
}

/** Does `expressId` (in `modelId`) sit in a storey ref'd by `rule.refs`?
 *  `IfcBuildingStorey.Name` isn't unique, so once a `StoreyRule` carries
 *  an exact (modelId, expressId) ref (mirrored from a HierarchyPanel
 *  click), matching bypasses Name entirely. */
export function storeyMatchesRefs(store: IfcDataStore, expressId: number, modelId: string, rule: StoreyRule): boolean {
  const storeyId = store.spatialHierarchy?.elementToStorey.get(expressId);
  return storeyId != null && !!rule.refs?.some((r) => r.modelId === modelId && r.expressId === storeyId);
}

/** Index-prefilter twin of {@link storeyMatchesRefs}/Name matching: the
 *  bucket of elements a `storey op:'in'` rule narrows to for `modelId`. */
export function unionByStorey(store: IfcDataStore, rule: StoreyRule, modelId: string | undefined): number[] | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const out: number[] = [];
  if (rule.refs) {
    for (const ref of rule.refs) {
      if (ref.modelId !== modelId) continue;
      const elements = hierarchy.byStorey.get(ref.expressId);
      if (elements) for (const id of elements) out.push(id);
    }
    return out.length > 0 ? out : null;
  }
  const wanted = new Set(rule.values.map((n) => n.toLowerCase()));
  for (const storeyId of hierarchy.byStorey.keys()) {
    const name = store.entities.getName(storeyId);
    if (!wanted.has(name.toLowerCase())) continue;
    const elements = hierarchy.byStorey.get(storeyId);
    if (elements) for (const id of elements) out.push(id);
  }
  return out.length > 0 ? out : null;
}

// ── Material / classification / elevation resolution ─────────────────────────

/** Collect the *individual* material names an element exposes - each layer /
 *  constituent / profile material, or the single plain material - for the
 *  multi-valued `material` rule matcher and the material dropdown. Shares the
 *  #1366 lens collector, so filtering by material groups by the real materials
 *  rather than the layer-set / Revit family+type name that masked them. (#1462) */
export function materialNamesOf(info: MaterialInfo | null): string[] {
  return lensMaterialNames(info);
}

/** Match a classification rule against an element's classification refs.
 *  `system` (when set) scopes to one classification system; value ops
 *  match a ref's code (identification) OR name. */
export function matchClassificationRule(
  rule: ClassificationRule,
  refs: readonly ClassificationInfo[],
): boolean {
  const sys = rule.system?.trim().toLowerCase();
  const scoped = sys
    ? refs.filter((r) => (r.system ?? '').toLowerCase() === sys)
    : refs;

  if (rule.op === 'isSet') return scoped.length > 0;
  if (rule.op === 'isNotSet') return scoped.length === 0;

  // Value ops — match against identification (code) and name of each ref.
  const candidates: string[] = [];
  for (const r of scoped) {
    if (r.identification) candidates.push(r.identification);
    if (r.name) candidates.push(r.name);
  }
  // rule.op is now eq | ne | contains | notContains — a StringOp subset.
  return matchStringAnyNone(rule.op, candidates, rule.value, rule.valueKind);
}

/** Element elevation in metres, derived from its building storey's
 *  elevation. Returns null when the element isn't placed in the spatial
 *  hierarchy (so an elevation rule simply doesn't match it). */
export function elevationOf(store: IfcDataStore, expressId: number): number | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const storeyId = hierarchy.elementToStorey.get(expressId);
  if (!storeyId) return null;
  const elev = hierarchy.storeyElevations.get(storeyId);
  return typeof elev === 'number' ? elev : null;
}
