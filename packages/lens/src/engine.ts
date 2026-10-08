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
} from './types.js';
import { classificationAbsenceReason, extractAutoColorValues } from './auto-color-values.js';
import { resolveLensScope } from './scoped-provider.js';
import type { CapturedEntityScope } from '@ifc-lite/rules';
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
 * @param matchedByRule - Global IDs selected by the shared FilterGroup
 *   evaluator for each rule. Missing entries fail closed.
 * @returns Color map, hidden IDs, per-rule counts, and execution time
 */
export function evaluateLens(
  lens: Lens,
  provider: LensDataProvider,
  matchedByRule: ReadonlyMap<string, ReadonlySet<number>>,
): LensEvaluationResult {
  const scopedIds = resolveLensScope(provider, lens.capturedScope);
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

  for (const rule of enabledRules) {
    ruleCounts.set(rule.id, 0);
    ruleEntityIds.set(rule.id, []);
  }

  provider.forEachEntity((globalId) => {
    if (scopedIds && !scopedIds.has(globalId)) return;
    let matched = false;

    // First matching rule wins
    for (const rule of enabledRules) {
      if (!rule.unreadableLegacy && matchedByRule.get(rule.id)?.has(globalId)) {
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
  capturedScope?: CapturedEntityScope,
): AutoColorEvaluationResult {
  const scopedIds = resolveLensScope(provider, capturedScope);
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
    if (scopedIds && !scopedIds.has(globalId)) return;
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
