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
import { flattenMaterials } from '@ifc-lite/ids';
import { collectSpatialAncestors } from '@ifc-lite/data';

import {
  type PropertyRule,
  type QuantityRule,
  type ClassificationRule,
  type AttributeRule,
  type StoreyRule,
  type ParentRule,
  type TextKind,
  type ValueOp,
} from './filter-rules.js';
import { valueOpMatches, numericOpMatches, matchStringAnyNone } from './filter-ops.js';
import { lensMaterialNames } from './lens-material-names.js';
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

export interface PsetRow {
  setName: string;
  propertyName: string;
  value: string;
  /** Retain primitive type so a converted Bulk condition cannot match a different typed value. */
  valueType?: 'string' | 'number' | 'boolean' | 'null';
}
export type PsetRows = ReadonlyArray<PsetRow>;

export interface QtyRow { setName: string; quantityName: string; value: number }
export type QtyRows = ReadonlyArray<QtyRow>;

/** Structures whose `values` are the candidates a rule reads (#5475). */
const ANY_MATCH_STRUCTURES = new Set(['enumerated', 'list', 'table']);

/**
 * The values a rule compares for one property: every member of an
 * enumerated or list value and every cell of a table, so a positive op
 * passes when ANY of them does (IDS / ifctester parity, #5475); otherwise the
 * single display value. An empty list keeps one blank candidate, so the
 * property still reads as present for `isSet`, as it did before.
 */
export function propertyCandidates(p: { value: unknown; values?: readonly string[]; structure?: string }): string[] {
  if (p.structure && ANY_MATCH_STRUCTURES.has(p.structure) && p.values && p.values.length > 0) return [...p.values];
  return [stringifyValue(p.value)];
}

export function flattenPsets(
  psets: ReturnType<typeof extractPropertiesOnDemand>,
): PsetRows {
  const out: PsetRow[] = [];
  for (const set of psets) {
    for (const p of set.properties) {
      const valueType: PsetRow['valueType'] = p.value === null || p.value === undefined ? 'null'
        : typeof p.value === 'string' ? 'string'
        : typeof p.value === 'number' ? 'number'
        : typeof p.value === 'boolean' ? 'boolean' : undefined;
      for (const value of propertyCandidates(p)) out.push({
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
        value,
        valueType,
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
  const matching = rows.filter(
    (r) =>
      nameMatches(rule.setName, r.setName, rule.setNameKind) &&
      nameMatches(rule.propertyName, r.propertyName, rule.propertyNameKind),
  );
  // Presence, non-null and non-empty are distinct in imported filters.
  if (rule.op === 'isSet') return matching.length > 0;
  if (rule.op === 'isNotSet') return matching.length === 0;
  if (rule.op === 'isNull') return matching.length === 0 || matching.some((r) => r.valueType === 'null');
  if (rule.op === 'isNotNull') return matching.some((r) => r.valueType !== 'null');
  if (rule.op === 'isNonEmpty') return matching.some((r) => r.valueType !== 'null' && r.value.length > 0);
  const comparable = rule.comparison ? matching.filter((r) => r.valueType !== 'null') : matching;

  // A negated op holds when NO candidate has the value (a list [A, B] is
  // not "!= A"), the ANY/NONE convention `material` and `parent` use and
  // validation's `checkValueOp` applies (#5475). With a single candidate
  // this is the same answer as before.
  const positive = NEGATED_VALUE_OP[rule.op];
  if (positive) return comparable.length > 0 && !comparable.some((r) => valueOpMatches(positive, r.value, rule.value, rule.valueKind, {
    ...rule.comparison, candidateType: r.valueType,
  }));
  return comparable.some((r) => valueOpMatches(rule.op, r.value, rule.value, rule.valueKind, {
    ...rule.comparison, candidateType: r.valueType,
  }));
}

/** A negated value op's positive form: the negation holds when NO candidate satisfies it (#5475). */
export const NEGATED_VALUE_OP: Partial<Record<ValueOp, ValueOp>> = { ne: 'eq', notContains: 'contains', notMatches: 'matches' };

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
  if (rule.op === 'isNull') return found === undefined;
  if (rule.op === 'isNotNull') return found !== undefined;
  if (rule.op === 'isNonEmpty') return (stringified ?? '').length > 0;
  if (stringified === undefined) return false;
  const candidateType = typeof found?.value;
  return valueOpMatches(rule.op, stringified, rule.value, rule.valueKind, {
    ...rule.comparison,
    candidateType: candidateType === 'string' || candidateType === 'number' || candidateType === 'boolean'
      ? candidateType : undefined,
  });
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

/**
 * Storey id an element belongs to: its own direct containment
 * (`elementToStorey`, set for an element the storey directly contains plus
 * its `IfcRelAggregates`-aggregated parts) OR — one hop through a
 * containing `IfcSpace`/`IfcSpatialZone` — the storey THAT space belongs
 * to. A space is itself mapped to its storey in `elementToStorey`
 * (`SpatialHierarchyBuilder` walks a storey's own spatial children), so
 * this is a composition of two maps that already exist plus
 * `getContainingSpace` (`@ifc-lite/data`'s `spatialLookups`), not a new
 * traversal. The single home for "which storey" so the per-entity
 * evaluator (`defaultStoreyName`/`storeyMatchesRefs`) and the bulk index
 * prefilter (`unionByStorey`) cannot answer it two different ways.
 *
 * Reaches exactly one level down from the storey: an element inside a
 * space nested inside another space (rather than directly under the
 * storey) is not resolved — see `docs/guide/selector-syntax.md`.
 */
function storeyIdOf(hierarchy: NonNullable<IfcDataStore['spatialHierarchy']>, expressId: number): number | undefined {
  const direct = hierarchy.elementToStorey.get(expressId);
  if (direct !== undefined) return direct;
  // `getContainingSpace` is part of the `spatialLookups()` contract every
  // real hierarchy carries, but several tests in this suite build a
  // hand-rolled partial `spatialHierarchy` mock (`byStorey`/`elementToStorey`
  // only) to exercise the ref/name-matching paths in isolation — guard
  // rather than assume every field is present.
  const spaceId = hierarchy.getContainingSpace?.(expressId);
  if (spaceId == null) return undefined;
  return hierarchy.elementToStorey.get(spaceId);
}

/** Every element `bySpace` lists for a space belonging to `storeyId` — the
 *  bulk-prefilter twin of {@link storeyIdOf}'s one-hop space widening.
 *  `bySpace` is absent on the same partial test mocks {@link storeyIdOf}
 *  guards against. */
function spaceElementsOfStorey(hierarchy: NonNullable<IfcDataStore['spatialHierarchy']>, storeyId: number): number[] {
  const out: number[] = [];
  if (!hierarchy.bySpace) return out;
  for (const [spaceId, elements] of hierarchy.bySpace) {
    if (hierarchy.elementToStorey.get(spaceId) !== storeyId) continue;
    for (const id of elements) out.push(id);
  }
  return out;
}

export function defaultStoreyName(store: IfcDataStore, expressId: number): string {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return '';
  const storeyId = storeyIdOf(hierarchy, expressId);
  if (!storeyId) return '';
  return store.entities.getName(storeyId);
}

/** Does `expressId` (in `modelId`) sit in a storey ref'd by `rule.refs`?
 *  `IfcBuildingStorey.Name` isn't unique, so once a `StoreyRule` carries
 *  an exact (modelId, expressId) ref (mirrored from a HierarchyPanel
 *  click), matching bypasses Name entirely. Reaches through a containing
 *  space via {@link storeyIdOf}, same as the Name-matched path. */
export function storeyMatchesRefs(store: IfcDataStore, expressId: number, modelId: string, rule: StoreyRule): boolean {
  const hierarchy = store.spatialHierarchy;
  const storeyId = hierarchy ? storeyIdOf(hierarchy, expressId) : undefined;
  return storeyId != null && !!rule.refs?.some((r) => r.modelId === modelId && r.expressId === storeyId);
}

/** Index-prefilter twin of {@link storeyMatchesRefs}/Name matching: the
 *  bucket of elements a `storey op:'in'` rule narrows to for `modelId`.
 *  Includes each matched storey's directly-contained elements AND every
 *  element `bySpace` lists for a space belonging to that storey, so this
 *  prefilter can never exclude a candidate the (also widened) per-entity
 *  check in `filter-evaluate.ts` would go on to match. */
export function unionByStorey(store: IfcDataStore, rule: StoreyRule, modelId: string | undefined): number[] | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const out: number[] = [];
  if (rule.refs) {
    for (const ref of rule.refs) {
      if (ref.modelId !== modelId) continue;
      const elements = hierarchy.byStorey.get(ref.expressId);
      if (elements) for (const id of elements) out.push(id);
      for (const id of spaceElementsOfStorey(hierarchy, ref.expressId)) out.push(id);
    }
    return out.length > 0 ? out : null;
  }
  const wanted = new Set(rule.values.map((n) => n.toLowerCase()));
  for (const storeyId of hierarchy.byStorey.keys()) {
    const name = store.entities.getName(storeyId);
    if (!wanted.has(name.toLowerCase())) continue;
    const elements = hierarchy.byStorey.get(storeyId);
    if (elements) for (const id of elements) out.push(id);
    for (const id of spaceElementsOfStorey(hierarchy, storeyId)) out.push(id);
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

/** `materialNamesOf` plus every material Category (`material=` matches
 *  Name OR Category, #4094) — categories come from `flattenMaterials`
 *  (`@ifc-lite/ids`'s material-facet flattener), reused rather than a
 *  second layer/profile/constituent walk; only its `.category` field is
 *  used, since its `.name` field also surfaces a layer's own label, which
 *  `materialNamesOf` deliberately excludes (#1462). */
export function materialMatchCandidates(info: MaterialInfo | null): string[] {
  const categories = flattenMaterials(info)
    .map((m) => m.category)
    .filter((c): c is string => !!c);
  return [...new Set([...materialNamesOf(info), ...categories])];
}

/**
 * Match a classification rule against an element's classification refs.
 * `system` (when set) scopes to one system; value ops match a ref's code
 * (identification) OR name. Pushes both through even when `undefined`
 * (absent) rather than filtering on truthy — `matchStringAnyNone` decides
 * absent-vs-empty explicitly (#4930).
 */
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
  // `unresolved` (server-parsed, no source bytes — #3948) means UNKNOWN, not
  // ABSENT: excluded from candidates entirely, same as before #4930, so it
  // can't flip a negative op false->true. Only a RESOLVED ref's genuinely
  // `$` identification/name contributes a real `undefined` candidate.
  const candidates: (string | undefined)[] = [];
  for (const r of scoped) {
    if (r.unresolved) continue;
    candidates.push(r.identification);
    candidates.push(r.name);
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

// ── Parent (spatial ancestor) resolution ──────────────────────────────────────

/**
 * `parent=Foo` (#4903) — does ANY ancestor of `expressId`, walking upward
 * through spatial containment and aggregation to any depth via
 * `collectSpatialAncestors` (`@ifc-lite/data`, the single shared resolver),
 * have a Name the rule's op matches? Reuses `matchStringAnyNone`, the same
 * multi-valued convention `material`/`classification` rules use: an element
 * with NO ancestors — or none whose Name matches — satisfies neither a
 * positive nor a negative op (#4659). `getNameOrUndefined`, not `getName`,
 * so an ancestor with no Name at all is a real absent candidate (#4930).
 */
export function matchParentRule(rule: ParentRule, store: IfcDataStore, expressId: number): boolean {
  const ancestorNames = collectSpatialAncestors(store.relationships, expressId)
    .map((id) => store.entities.getNameOrUndefined(id));
  return matchStringAnyNone(rule.op, ancestorNames, rule.value, rule.valueKind);
}
