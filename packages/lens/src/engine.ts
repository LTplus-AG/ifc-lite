/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  Lens,
  LensEvaluationResult,
  LensDataProvider,
  RGBAColor,
  LensRule,
  AutoColorSpec,
  AutoColorLegendEntry,
  ClassificationInfo,
} from './types.js';
import { matchesCriteria } from './matching.js';
import { hexToRgba, GHOST_COLOR, uniqueColor } from './colors.js';

/**
 * Evaluate a lens against all entities in the data provider.
 *
 * - O(n × r) where n = entity count, r = enabled rules
 * - First matching rule wins (short-circuit per entity)
 * - Unmatched entities receive {@link GHOST_COLOR} for context
 *
 * @param lens - Lens configuration to evaluate
 * @param provider - Data provider for entity access
 * @returns Color map, hidden IDs, per-rule counts, and execution time
 */
export function evaluateLens(
  lens: Lens,
  provider: LensDataProvider,
): LensEvaluationResult {
  const startTime = performance.now();

  const enabledRules = lens.rules.filter(r => r.enabled);

  // Early exit — no enabled rules means no evaluation
  if (enabledRules.length === 0) {
    return {
      colorMap: new Map(),
      hiddenIds: new Set(),
      ruleCounts: new Map(),
      ruleEntityIds: new Map(),
      executionTime: performance.now() - startTime,
    };
  }

  const colorMap = new Map<number, RGBAColor>();
  const hiddenIds = new Set<number>();
  const ruleCounts = new Map<string, number>();
  const ruleEntityIds = new Map<string, number[]>();

  // Initialize rule counts and entity ID lists
  for (const rule of enabledRules) {
    ruleCounts.set(rule.id, 0);
    ruleEntityIds.set(rule.id, []);
  }

  // Evaluate all entities
  provider.forEachEntity((globalId) => {
    let matched = false;

    // First matching rule wins
    for (const rule of enabledRules) {
      if (matchesCriteria(rule.criteria, globalId, provider)) {
        matched = true;
        ruleCounts.set(rule.id, (ruleCounts.get(rule.id) ?? 0) + 1);
        ruleEntityIds.get(rule.id)!.push(globalId);
        applyRuleAction(rule, globalId, colorMap, hiddenIds);
        break;
      }
    }

    // Ghost unmatched entities for context
    if (!matched) {
      colorMap.set(globalId, GHOST_COLOR);
    }
  });

  return {
    colorMap,
    hiddenIds,
    ruleCounts,
    ruleEntityIds,
    executionTime: performance.now() - startTime,
  };
}

/** Apply rule action to an entity */
function applyRuleAction(
  rule: LensRule,
  globalId: number,
  colorMap: Map<number, RGBAColor>,
  hiddenIds: Set<number>,
): void {
  switch (rule.action) {
    case 'colorize':
      colorMap.set(globalId, hexToRgba(rule.color, 1));
      break;
    case 'transparent':
      colorMap.set(globalId, hexToRgba(rule.color, 0.3));
      break;
    case 'hide':
      hiddenIds.add(globalId);
      break;
  }
}

// ============================================================================
// Auto-Color Evaluation
// ============================================================================

/**
 * Result of auto-color lens evaluation, extends standard result
 * with legend entries for UI display.
 */
export interface AutoColorEvaluationResult extends LensEvaluationResult {
  /** Legend entries for UI — one per distinct value, sorted by count desc */
  legend: AutoColorLegendEntry[];
}

/**
 * Reserved rule ids and neutral (unsaturated) colors for the two "absence"
 * legend buckets. Fixed rather than drawn from {@link uniqueColor} so that:
 *  - they never compete with real values for a rank-based palette slot —
 *    turning `includeUnclassified` on/off cannot shift the colors assigned to
 *    real classification groups, and a large absence bucket can't grab the
 *    most-saturated color and read as if it were the biggest *category*
 *    rather than a gap in the data;
 *  - they are visually distinguishable from both a real value (saturated,
 *    golden-angle hues) and {@link GHOST_COLOR} (very low alpha, near
 *    invisible) — an absence bucket is deliberately visible and clickable.
 */
const NO_CLASSIFICATION_RULE_ID = 'auto-absent-no-classification';
const NOT_IN_SYSTEM_RULE_ID = 'auto-absent-not-in-system';
const NO_CLASSIFICATION_COLOR = '#8a8a8a';
const NOT_IN_SYSTEM_COLOR = '#bdbdbd';

/**
 * Evaluate an auto-color lens against all entities.
 *
 * Single O(n) pass: extracts the target value for each entity, groups by
 * distinct values, and assigns colors from the palette.
 *
 * @param autoColor - Data source specification
 * @param provider - Data provider for entity access
 * @returns Color map, legend, and per-value entity IDs
 */
export function evaluateAutoColorLens(
  autoColor: AutoColorSpec,
  provider: LensDataProvider,
): AutoColorEvaluationResult {
  const startTime = performance.now();

  // Phase 1: Extract values and group entities by distinct value
  const valueGroups = new Map<string, number[]>();
  // Grouping key -> legend label (first occurrence wins). Differs from the key
  // only for classification, which shows the name alongside System: Code. (#1460)
  const valueLabels = new Map<string, string>();
  const ghostIds: number[] = [];

  // Value-less entities, split by *why* they have no value — only populated
  // when `includeUnclassified` opts in (classification source only; see
  // AutoColorSpec.includeUnclassified). Left empty otherwise, so the ghosting
  // behaviour below is byte-for-byte the pre-existing one when the flag is
  // off or the source isn't classification.
  const noClassificationIds: number[] = [];
  const notInSystemIds: number[] = [];
  const wantsAbsenceBuckets = autoColor.source === 'classification' && autoColor.includeUnclassified === true;

  provider.forEachEntity((globalId) => {
    // Most sources yield a single value; `material` can yield several — an
    // element built from a layer / constituent set belongs to EVERY one of its
    // materials, so it may join multiple value groups (#1366).
    const values = extractAutoColorValues(autoColor, globalId, provider);

    if (values.length === 0) {
      if (wantsAbsenceBuckets) {
        if (classificationAbsenceReason(autoColor, globalId, provider) === 'not-in-system') {
          notInSystemIds.push(globalId);
        } else {
          noClassificationIds.push(globalId);
        }
      } else {
        ghostIds.push(globalId);
      }
      return;
    }

    for (const { key, label } of values) {
      let group = valueGroups.get(key);
      if (!group) {
        group = [];
        valueGroups.set(key, group);
        valueLabels.set(key, label);
      }
      group.push(globalId);
    }
  });

  // Phase 2: Sort distinct values by entity count (descending) for best color allocation
  const sortedEntries = Array.from(valueGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);

  // Phase 3: Assign colors and build result
  const colorMap = new Map<number, RGBAColor>();
  const hiddenIds = new Set<number>();
  const ruleCounts = new Map<string, number>();
  const ruleEntityIds = new Map<string, number[]>();
  const legend: AutoColorLegendEntry[] = [];

  for (let i = 0; i < sortedEntries.length; i++) {
    const [value, entityIds] = sortedEntries[i];
    const color = uniqueColor(i);
    const ruleId = `auto-${i}`;
    const rgba = hexToRgba(color, 1);

    for (const id of entityIds) {
      // An element may belong to several value groups (e.g. multi-material).
      // It renders in a single colour, so the first group wins — groups are
      // sorted by count desc, so that is the element's largest material group.
      if (!colorMap.has(id)) colorMap.set(id, rgba);
    }

    ruleCounts.set(ruleId, entityIds.length);
    ruleEntityIds.set(ruleId, entityIds);
    const displayName = autoColor.source === 'model'
      ? (provider.getModelName?.(value) ?? value)
      : (valueLabels.get(value) ?? value);
    legend.push({ id: ruleId, name: displayName, color, count: entityIds.length });
  }

  // Phase 4: Absence buckets — appended after every real value, never
  // competing for a rank-based color (see the constants above). Each bucket
  // only appears when it is non-empty, and "Not in this system" only exists
  // at all when `psetName` names a specific system to be "not in" (see
  // AutoColorSpec.includeUnclassified) — with no system named there is
  // nothing to distinguish it from "No classification", so emitting an empty
  // or duplicate second bucket would be noise, not data.
  const absenceBuckets: Array<{ ruleId: string; name: string; color: string; ids: number[] }> = [];
  if (noClassificationIds.length > 0) {
    absenceBuckets.push({ ruleId: NO_CLASSIFICATION_RULE_ID, name: 'No classification', color: NO_CLASSIFICATION_COLOR, ids: noClassificationIds });
  }
  if (notInSystemIds.length > 0) {
    absenceBuckets.push({ ruleId: NOT_IN_SYSTEM_RULE_ID, name: 'Not in this system', color: NOT_IN_SYSTEM_COLOR, ids: notInSystemIds });
  }
  absenceBuckets.sort((a, b) => b.ids.length - a.ids.length);

  for (const bucket of absenceBuckets) {
    const rgba = hexToRgba(bucket.color, 1);
    for (const id of bucket.ids) {
      colorMap.set(id, rgba);
    }
    ruleCounts.set(bucket.ruleId, bucket.ids.length);
    ruleEntityIds.set(bucket.ruleId, bucket.ids);
    legend.push({ id: bucket.ruleId, name: bucket.name, color: bucket.color, count: bucket.ids.length, isAbsent: true });
  }

  // Ghost unmatched (null/empty value) entities that didn't land in an
  // absence bucket above — either `includeUnclassified` is off/not
  // applicable (the pre-existing behaviour, unchanged), or the source isn't
  // classification.
  for (const id of ghostIds) {
    colorMap.set(id, GHOST_COLOR);
  }

  return {
    colorMap,
    hiddenIds,
    ruleCounts,
    ruleEntityIds,
    legend,
    executionTime: performance.now() - startTime,
  };
}

/**
 * A grouping key plus the human-readable label shown in the legend. They are
 * identical for every source except `classification`, where grouping stays by
 * `System: Code` (stable identity) but the label also surfaces the name, so the
 * same code never fragments across slightly different names. (#1460)
 */
interface AutoColorValue {
  key: string;
  label: string;
}

/**
 * Pick the classification reference to group by - the one whose system matches
 * `psetName` (case-insensitive substring) when set, else the first.
 *
 * When `psetName` is set it acts as a classification-system FILTER: an entity
 * that carries classifications but none from the selected system must not be
 * grouped under some other, unrelated system. Returns `undefined` in that
 * case so the caller ghosts the entity instead of silently falling back to
 * `cls[0]` (#1923 — the "System" picker on the classification auto-color lens
 * was a no-op because every entity fell back to its first classification
 * regardless of which system was selected).
 */
function selectClassificationRef(
  cls: ReadonlyArray<ClassificationInfo>,
  psetName?: string,
): ClassificationInfo | undefined {
  if (!psetName) return cls[0];
  return cls.find((ref) => (ref.system ?? '').toLowerCase().includes(psetName.toLowerCase()));
}

/**
 * Why a `source: "classification"` entity produced zero grouping values —
 * used only when {@link AutoColorSpec.includeUnclassified} is on, to route
 * the entity into the right absence bucket instead of ghosting it. Only
 * called once {@link extractAutoColorValues} has already returned `[]` for
 * this entity/spec pair.
 *
 * - `'no-classification'`: zero classification references at all, OR (with
 *   no `psetName` filter) any value-less reason — there is no specific
 *   system to be "not in", so everything collapses to one bucket.
 * - `'not-in-system'`: the entity carries references, `psetName` names a
 *   system, and none of the references matched it
 *   ({@link selectClassificationRef} returned `undefined`).
 *
 * One degenerate case folds into `'no-classification'` even though a
 * reference *did* match the selected system: a classification record with an
 * empty system, identification, AND name (garbage/placeholder data). It
 * carries no usable value, so — like having no classification at all — there
 * is nothing to color it by; calling it "not in this system" would be wrong,
 * since it IS in the system, just empty.
 */
function classificationAbsenceReason(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): 'no-classification' | 'not-in-system' {
  const cls = provider.getClassifications?.(globalId);
  if (!cls || cls.length === 0) return 'no-classification';
  if (!spec.psetName) return 'no-classification';
  const matched = selectClassificationRef(cls, spec.psetName);
  return matched ? 'no-classification' : 'not-in-system';
}

/**
 * Extract every distinct value an entity should be grouped under. Only
 * `material` is multi-valued — an element with a layer / constituent set
 * belongs to each of its individual materials; all other sources collapse to
 * a single value. Values are trimmed and de-duplicated; empties are dropped.
 * Falls back to the single-valued {@link extractAutoColorValue} when the
 * multi-material accessor is unavailable. (#1366)
 */
function extractAutoColorValues(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): AutoColorValue[] {
  // Classification: group by "System: Code", but label with the name too so the
  // legend reads e.g. "Uniclass: EF_25_10 (Walls)". (#1460)
  if (spec.source === 'classification' && provider.getClassifications) {
    const cls = provider.getClassifications(globalId);
    if (!cls || cls.length === 0) return [];
    const c = selectClassificationRef(cls, spec.psetName);
    if (!c) return [];
    const codeParts: string[] = [];
    if (c.system) codeParts.push(c.system);
    if (c.identification) codeParts.push(c.identification);
    const code = codeParts.join(': ');
    const name = c.name?.trim();
    const key = code || name || '';
    if (key === '') return [];
    // Append the name only when it adds information beyond the code: skip it when
    // it merely repeats the bare identification OR the full "System: Code" string
    // (some exports store the whole code in the name attribute).
    const nameAddsInfo = !!name && name !== c.identification && name !== code;
    const label = code && nameAddsInfo ? `${code} (${name})` : key;
    return [{ key, label }];
  }

  if (spec.source === 'material' && provider.getMaterialNames) {
    const names = provider.getMaterialNames(globalId);
    if (names && names.length > 0) {
      const seen = new Set<string>();
      for (const n of names) {
        const t = (n ?? '').trim();
        if (t) seen.add(t);
      }
      if (seen.size > 0) return [...seen].map((k) => ({ key: k, label: k }));
    }
    // else fall through to the single-valued accessor
  }

  const raw = extractAutoColorValue(spec, globalId, provider);
  const value = raw != null ? String(raw).trim() : '';
  return value === '' ? [] : [{ key: value, label: value }];
}

/**
 * Extract the target value for a single entity based on the auto-color spec.
 * Returns the raw value (string, number, etc.) or undefined if not available.
 */
function extractAutoColorValue(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): string | number | undefined {
  switch (spec.source) {
    case 'ifcType':
      return provider.getEntityType(globalId);

    case 'attribute':
      if (!spec.propertyName || !provider.getEntityAttribute) return undefined;
      return provider.getEntityAttribute(globalId, spec.propertyName);

    case 'property':
      if (!spec.psetName || !spec.propertyName) return undefined;
      {
        const val = provider.getPropertyValue(globalId, spec.psetName, spec.propertyName);
        return val != null ? String(val) : undefined;
      }

    case 'quantity':
      if (!spec.psetName || !spec.propertyName || !provider.getQuantityValue) return undefined;
      return provider.getQuantityValue(globalId, spec.psetName, spec.propertyName);

    case 'classification':
      if (!provider.getClassifications) return undefined;
      {
        const cls = provider.getClassifications(globalId);
        if (!cls || cls.length === 0) return undefined;
        // Use "system: identification" as the grouping key. When psetName is set,
        // treat it as a classification-system filter (mirroring matchesClassification),
        // selecting the matching reference instead of unconditionally using the first.
        const c = selectClassificationRef(cls, spec.psetName);
        if (!c) return undefined;
        const parts: string[] = [];
        if (c.system) parts.push(c.system);
        if (c.identification) parts.push(c.identification);
        return parts.length > 0 ? parts.join(': ') : c.name;
      }

    case 'material':
      if (!provider.getMaterialName) return undefined;
      return provider.getMaterialName(globalId);

    case 'model':
      if (!provider.getModelId) return undefined;
      return provider.getModelId(globalId);

    case 'group': {
      if (!provider.getEntityGroups) return undefined;
      const groups = provider.getEntityGroups(globalId);
      if (!groups || groups.length === 0) return undefined;
      // Prefer an IfcZone membership so multi-group entities (IfcZone +
      // IfcGroup/IfcSystem) bucket by zone deterministically, not by whichever
      // relation happened to come first. Use the name when present, then the
      // ObjectType (e.g. a system designation), else "Type #id" so unnamed
      // groups still bucket distinctly. (#1075)
      const g = groups.find((x) => x.type === 'IfcZone') ?? groups[0];
      if (g.name && g.name.trim() !== '') return g.name;
      if (g.objectType && g.objectType.trim() !== '') return `${g.type}: ${g.objectType}`;
      return `${g.type} #${g.id}`;
    }

    default:
      return undefined;
  }
}
