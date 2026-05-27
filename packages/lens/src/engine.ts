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
  const ghostIds: number[] = [];

  provider.forEachEntity((globalId) => {
    const raw = extractAutoColorValue(autoColor, globalId, provider);
    const value = raw != null ? String(raw).trim() : '';

    if (value === '') {
      ghostIds.push(globalId);
      return;
    }

    let group = valueGroups.get(value);
    if (!group) {
      group = [];
      valueGroups.set(value, group);
    }
    group.push(globalId);
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
      colorMap.set(id, rgba);
    }

    ruleCounts.set(ruleId, entityIds.length);
    ruleEntityIds.set(ruleId, entityIds);
    const displayName = autoColor.source === 'model'
      ? (provider.getModelName?.(value) ?? value)
      : value;
    legend.push({ id: ruleId, name: displayName, color, count: entityIds.length });
  }

  // Ghost unmatched (null/empty value) entities
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
        // Use "system: identification" as the grouping key
        const c = cls[0];
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

    default:
      return undefined;
  }
}
