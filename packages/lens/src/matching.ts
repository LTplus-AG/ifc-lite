/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LensCriteria, LensDataProvider, LensOperator } from './types.js';
import { IFC_SUBTYPE_TO_BASE, MAX_COMPOUND_DEPTH } from './types.js';

/**
 * Equality test for the `equals` operator.
 *
 * Exact string match, with one tolerance: boolean values compare
 * case-insensitively. `String(true)` yields the lowercase `"true"`, but the
 * properties panel surfaces IFC booleans capitalized as `True` / `False`. A
 * user who types the value they see ("True") would otherwise never match the
 * lowercase form the engine compares against. Non-boolean strings stay
 * case-sensitive so genuinely case-significant values (codes, fire ratings)
 * keep matching exactly. (#1403)
 */
function valueEquals(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const a = actual.toLowerCase();
  if (a !== expected.toLowerCase()) return false;
  return a === 'true' || a === 'false';
}

/** The operators added on top of the original `equals` / `contains` / `exists`. */
type ComparisonOperator = 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

function isComparisonOperator(op: LensOperator | undefined): op is ComparisonOperator {
  return op === 'ne' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
}

/**
 * Coerce a stored IFC value to a finite number, or `null` when it is not one.
 *
 * IFC values reach the lens as numbers, numeric strings ("300" - quantities and
 * properties both arrive stringified from several providers), or genuinely
 * non-numeric strings and booleans. Numeric strings must compare numerically or
 * the operators would be useless on the most common provider shape; anything
 * that does not parse finite yields `null` so the caller can fail closed rather
 * than let a `NaN` comparison decide the outcome.
 *
 * `Number.parseFloat` (not `Number()`) is deliberate: it is what the viewer's
 * search rule model uses in `valueOpMatches`
 * (`apps/viewer/src/lib/search/filter-rules.ts`), so a lens condition and the
 * equivalent search rule agree on every input - including the lenient tail
 * ("60 min" parses as 60) and the strict rejections ("" and "REI60" do not
 * parse). Diverging here would be a defect in itself.
 *
 * The `Number.isFinite` guard is load-bearing beyond `NaN`: `NaN` comparisons
 * are false anyway, but `parseFloat("Infinity")` yields `Infinity`, which would
 * otherwise satisfy any `gt`/`gte` against a real threshold.
 */
function toFiniteNumber(value: unknown): number | null {
  // Numbers skip the String() round-trip; everything else (numeric strings,
  // booleans, objects) goes through parseFloat and is rejected if it fails.
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Apply a {@link ComparisonOperator} to a present value.
 *
 * Callers must have established that `actual` is present - absence is decided
 * per criteria type (a property may legitimately be the empty string; an
 * attribute may not) and never matches a comparison operator.
 *
 * `ne` is a string comparison, matching the search layer where `eq`/`ne` are
 * string ops and only `gt`/`gte`/`lt`/`lte` parse numerically. Unlike
 * `equals` (which is case-sensitive except for the boolean literal tolerance,
 * see {@link valueEquals}), `ne` compares case-insensitively - this
 * deliberately mirrors `valueOpMatches`'s `ne` in the viewer's search rule
 * model (`apps/viewer/src/lib/search/filter-rules.ts`), which is
 * `lower(psetVal) !== lower(ruleVal)`, so a lens condition and the equivalent
 * search rule agree. `equals` and `ne` are therefore NOT exact complements
 * for a case-differing non-boolean value (e.g. `Note: 'REI60'` vs `ne
 * 'rei60'`: `equals` is false, `ne` is also false) - this is intentional
 * parity with the search layer, not a bug.
 */
function matchesComparison(
  operator: ComparisonOperator,
  actual: unknown,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false;

  if (operator === 'ne') return String(actual).toLowerCase() !== expected.toLowerCase();

  const a = toFiniteNumber(actual);
  const b = toFiniteNumber(expected);
  if (a === null || b === null) return false;

  switch (operator) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
  }
}

/**
 * Check if an entity matches a {@link LensCriteria}.
 *
 * Performance: O(1) for type/attribute, O(psets) for property/material/classification.
 */
export function matchesCriteria(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  return matchesCriteriaAtDepth(criteria, globalId, provider, 0);
}

/**
 * Depth-tracked core of {@link matchesCriteria}. `depth` counts how many
 * compound levels enclose `criteria` (0 at the top) so a pathological
 * hand-edited lens file cannot recurse unboundedly - beyond
 * {@link MAX_COMPOUND_DEPTH} a compound fails closed like every other
 * incomplete criterion in this engine.
 */
function matchesCriteriaAtDepth(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
  depth: number,
): boolean {
  switch (criteria.type) {
    case 'and':
    case 'or':
      return matchesCompound(criteria, globalId, provider, depth);
    case 'ifcType':
      return matchesIfcType(criteria, globalId, provider);
    case 'property':
      return matchesProperty(criteria, globalId, provider);
    case 'material':
      return matchesMaterial(criteria, globalId, provider);
    case 'attribute':
      return matchesAttribute(criteria, globalId, provider);
    case 'quantity':
      return matchesQuantity(criteria, globalId, provider);
    case 'classification':
      return matchesClassification(criteria, globalId, provider);
    case 'model':
      return matchesModel(criteria, globalId, provider);
    case 'group':
      return matchesGroup(criteria, globalId, provider);
    default:
      return false;
  }
}

/**
 * Evaluate an `and` / `or` compound over its member criteria.
 *
 * Fail-closed edges (see the {@link LensCriteria} doc): an empty or missing
 * `conditions` array matches nothing for BOTH operators - a vacuously-true
 * empty `and` would colorize the entire model off an incomplete rule - and
 * nesting past {@link MAX_COMPOUND_DEPTH} matches nothing. Members
 * short-circuit in array order like `Array#every` / `Array#some`.
 */
function matchesCompound(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
  depth: number,
): boolean {
  if (depth >= MAX_COMPOUND_DEPTH) return false;
  const members = criteria.conditions;
  if (!members || members.length === 0) return false;

  if (criteria.type === 'and') {
    return members.every((m) => matchesMember(m, globalId, provider, depth));
  }
  return members.some((m) => matchesMember(m, globalId, provider, depth));
}

/**
 * Evaluate one compound member, treating a malformed member as non-matching.
 *
 * `conditions` can arrive from hand-edited lens JSON, and the viewer's import
 * validator checks only the top-level criteria shape - it does not recurse
 * into members. A `null` / primitive member must fail its slot closed like
 * any other non-matching member (an `or` can still match on the rest), not
 * throw out of `evaluateLens` mid-iteration.
 */
function matchesMember(
  member: unknown,
  globalId: number,
  provider: LensDataProvider,
  depth: number,
): boolean {
  if (!isCriteriaRecord(member)) return false;
  return matchesCriteriaAtDepth(member, globalId, provider, depth + 1);
}

/** Runtime shape guard for a compound member: an object can be dispatched on
 *  `.type` (an unknown `type` falls to the evaluator's `default: false`);
 *  anything else cannot. */
function isCriteriaRecord(member: unknown): member is LensCriteria {
  return member !== null && typeof member === 'object';
}

/** Match by IFC class with subclass support */
function matchesIfcType(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.ifcType) return false;

  const typeName = provider.getEntityType(globalId);
  if (!typeName) return false;

  // Exact match
  if (typeName === criteria.ifcType) return true;

  // Subtype match: e.g. IfcSlabStandardCase matches an IfcSlab rule
  const baseType = IFC_SUBTYPE_TO_BASE[typeName];
  return baseType === criteria.ifcType;
}

/** Match by property value */
function matchesProperty(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.propertySet || !criteria.propertyName) return false;

  const value = provider.getPropertyValue(
    globalId,
    criteria.propertySet,
    criteria.propertyName,
  );

  if (criteria.operator === 'exists') {
    return value !== null && value !== undefined;
  }

  if (criteria.operator === 'contains' && criteria.propertyValue !== undefined) {
    return String(value ?? '').toLowerCase().includes(criteria.propertyValue.toLowerCase());
  }

  // An absent property never satisfies a comparison - mirroring the search
  // layer, where the rule matches over the rows that exist so a missing
  // property fails even the negative ops.
  if (isComparisonOperator(criteria.operator)) {
    if (value === null || value === undefined) return false;
    return matchesComparison(criteria.operator, value, criteria.propertyValue);
  }

  // Default: equals
  if (criteria.propertyValue !== undefined) {
    return valueEquals(String(value ?? ''), criteria.propertyValue);
  }

  return value !== null && value !== undefined;
}

/** Match by material — prefers dedicated getMaterialName, falls back to pset scan */
function matchesMaterial(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.materialName) return false;

  const pattern = criteria.materialName.toLowerCase();

  // Match against BOTH the individual constituent materials AND the single /
  // layer-set name. A multi-layer element should match on any of its materials
  // ("gypsumboard" matches a wall whose layer set also has insulation), and a
  // rule built from the discovery dropdown — which may surface either an
  // individual name or the layer-set name (e.g. "Basic Wall: Ext - Gyp/Ins") —
  // must still match. Checking only one accessor regressed the other. (#1366)
  if (provider.getMaterialNames || provider.getMaterialName) {
    const names = provider.getMaterialNames?.(globalId);
    if (names && names.some((n) => n.toLowerCase().includes(pattern))) return true;
    const matName = provider.getMaterialName?.(globalId);
    if (matName && matName.toLowerCase().includes(pattern)) return true;
    // A dedicated material accessor exists; don't fall through to the pset scan.
    return false;
  }

  // Fallback: scan material-related property sets
  const psets = provider.getPropertySets(globalId);
  if (!psets || psets.length === 0) return false;

  for (const pset of psets) {
    if (pset.name.toLowerCase().includes('material')) {
      for (const prop of pset.properties) {
        if (String(prop.value ?? '').toLowerCase().includes(pattern)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Match by entity attribute (Name, Description, ObjectType, Tag) */
function matchesAttribute(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.attributeName) return false;
  if (!provider.getEntityAttribute) return false;

  const value = provider.getEntityAttribute(globalId, criteria.attributeName);

  if (criteria.operator === 'exists') {
    return value !== undefined && value !== '';
  }

  if (criteria.operator === 'contains' && criteria.attributeValue !== undefined) {
    return (value ?? '').toLowerCase().includes(criteria.attributeValue.toLowerCase());
  }

  // Absence for an attribute is undefined OR '' - the same test the `exists`
  // branch above uses.
  if (isComparisonOperator(criteria.operator)) {
    if (value === undefined || value === '') return false;
    return matchesComparison(criteria.operator, value, criteria.attributeValue);
  }

  // Default: equals
  if (criteria.attributeValue !== undefined) {
    return valueEquals(value ?? '', criteria.attributeValue);
  }

  return value !== undefined && value !== '';
}

/** Match by quantity value (equals, contains, exists, ne, gt, gte, lt, lte) */
function matchesQuantity(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.quantitySet || !criteria.quantityName) return false;
  if (!provider.getQuantityValue) return false;

  const value = provider.getQuantityValue(
    globalId,
    criteria.quantitySet,
    criteria.quantityName,
  );

  if (criteria.operator === 'exists') {
    return value !== undefined && value !== null;
  }

  if (value === undefined || value === null) return false;

  if (criteria.operator === 'contains' && criteria.quantityValue !== undefined) {
    return String(value).toLowerCase().includes(criteria.quantityValue.toLowerCase());
  }

  // `value` is already known present here (guarded above), so no extra check.
  if (isComparisonOperator(criteria.operator)) {
    return matchesComparison(criteria.operator, value, criteria.quantityValue);
  }

  // Default: equals (string comparison)
  if (criteria.quantityValue !== undefined) {
    return valueEquals(String(value), criteria.quantityValue);
  }

  return true;
}

/** Match by classification system and/or code */
function matchesClassification(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.classificationSystem && !criteria.classificationCode) return false;
  if (!provider.getClassifications) return false;

  const classifications = provider.getClassifications(globalId);
  if (!classifications || classifications.length === 0) return false;

  for (const cls of classifications) {
    const systemMatch = !criteria.classificationSystem ||
      (cls.system ?? '').toLowerCase().includes(criteria.classificationSystem.toLowerCase());
    const codeMatch = !criteria.classificationCode ||
      (cls.identification ?? '').toLowerCase().includes(criteria.classificationCode.toLowerCase());

    if (systemMatch && codeMatch) return true;
  }

  return false;
}

/** Match by federated model identifier */
function matchesModel(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.modelId) return false;
  if (!provider.getModelId) return false;

  return provider.getModelId(globalId) === criteria.modelId;
}

/** Match by group/zone membership (IfcRelAssignsToGroup). Matches when the
 *  entity belongs to a group whose name contains `groupName` (case-insensitive);
 *  with no `groupName` set, matches any entity that belongs to at least one
 *  group/zone. */
function matchesGroup(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!provider.getEntityGroups) return false;
  const groups = provider.getEntityGroups(globalId);
  if (!groups || groups.length === 0) return false;

  if (!criteria.groupName) return true;
  const needle = criteria.groupName.toLowerCase();
  return groups.some((g) => (g.name ?? '').toLowerCase().includes(needle));
}
