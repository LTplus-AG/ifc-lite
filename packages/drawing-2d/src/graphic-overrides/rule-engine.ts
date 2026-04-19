/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Graphic Overrides Rule Engine
 *
 * Evaluates override rules against element data and resolves
 * the final graphic style to apply.
 */

import type {
  GraphicOverrideRule,
  OverrideCriteria,
  OverrideCriterion,
  CriteriaOperator,
  ElementData,
  GraphicStyle,
  ResolvedGraphicStyle,
  OverrideResult,
  LineWeightPreset,
  LineStylePreset,
  DashPattern,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Line weight presets in mm */
const LINE_WEIGHT_VALUES: Record<LineWeightPreset, number> = {
  heavy: 0.5,
  medium: 0.35,
  light: 0.25,
  hairline: 0.18,
};

/** Dash pattern presets [dash, gap, ...] in mm */
const DASH_PATTERNS: Record<LineStylePreset, number[]> = {
  solid: [],
  dashed: [2, 1],
  dotted: [0.5, 0.5],
  dashdot: [3, 1, 0.5, 1],
  center: [6, 1, 1, 1],
};

/** Default resolved style */
const DEFAULT_STYLE: ResolvedGraphicStyle = {
  fillColor: '#CCCCCC',
  strokeColor: '#000000',
  backgroundColor: '#FFFFFF',
  lineWeight: 0.25,
  lineCap: 'round',
  lineJoin: 'round',
  dashPattern: [],
  hatchPattern: 'none',
  hatchSpacing: 3,
  hatchAngle: 45,
  hatchSecondaryAngle: -45,
  hatchColor: '#000000',
  hatchLineWeight: 0.13,
  visible: true,
  opacity: 1,
  drawOrder: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// IFC TYPE HIERARCHY (for subtype matching)
// ═══════════════════════════════════════════════════════════════════════════

const IFC_TYPE_HIERARCHY: Record<string, string[]> = {
  IfcWall: ['IfcWallStandardCase', 'IfcWallElementedCase'],
  IfcSlab: ['IfcSlabStandardCase', 'IfcSlabElementedCase'],
  IfcBeam: ['IfcBeamStandardCase'],
  IfcColumn: ['IfcColumnStandardCase'],
  IfcDoor: ['IfcDoorStandardCase'],
  IfcWindow: ['IfcWindowStandardCase'],
  IfcMember: ['IfcMemberStandardCase'],
  IfcPlate: ['IfcPlateStandardCase'],
  IfcStair: ['IfcStairFlight'],
  IfcRamp: ['IfcRampFlight'],
  IfcBuildingElement: [
    'IfcWall', 'IfcSlab', 'IfcBeam', 'IfcColumn', 'IfcDoor', 'IfcWindow',
    'IfcStair', 'IfcRamp', 'IfcRoof', 'IfcRailing', 'IfcCovering',
  ],
  IfcDistributionElement: [
    'IfcDistributionFlowElement', 'IfcDistributionControlElement',
  ],
  IfcFlowElement: [
    'IfcFlowTerminal', 'IfcFlowSegment', 'IfcFlowFitting', 'IfcFlowController',
  ],
};

function getIfcSubtypes(ifcType: string): string[] {
  const subtypes = IFC_TYPE_HIERARCHY[ifcType] || [];
  const allSubtypes = [...subtypes];

  // Recursively get subtypes of subtypes
  for (const subtype of subtypes) {
    allSubtypes.push(...getIfcSubtypes(subtype));
  }

  return allSubtypes;
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITERION EVALUATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a comparison operator
 */
function evaluateOperator(
  actual: unknown,
  operator: CriteriaOperator,
  expected: unknown
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;

    case 'notEquals':
      return actual !== expected;

    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      return false;

    case 'notContains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return !actual.toLowerCase().includes(expected.toLowerCase());
      }
      return true;

    case 'startsWith':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase().startsWith(expected.toLowerCase());
      }
      return false;

    case 'endsWith':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase().endsWith(expected.toLowerCase());
      }
      return false;

    case 'greaterThan':
      if (typeof actual === 'number' && typeof expected === 'number') {
        return actual > expected;
      }
      return false;

    case 'lessThan':
      if (typeof actual === 'number' && typeof expected === 'number') {
        return actual < expected;
      }
      return false;

    case 'greaterOrEqual':
      if (typeof actual === 'number' && typeof expected === 'number') {
        return actual >= expected;
      }
      return false;

    case 'lessOrEqual':
      if (typeof actual === 'number' && typeof expected === 'number') {
        return actual <= expected;
      }
      return false;

    case 'exists':
      return actual !== undefined && actual !== null;

    case 'notExists':
      return actual === undefined || actual === null;

    case 'in':
      if (Array.isArray(expected)) {
        return expected.includes(actual);
      }
      return false;

    case 'notIn':
      if (Array.isArray(expected)) {
        return !expected.includes(actual);
      }
      return true;

    default:
      return false;
  }
}

/**
 * Evaluate a single criterion against element data
 */
function evaluateCriterion(criterion: OverrideCriterion, element: ElementData): boolean {
  switch (criterion.type) {
    case 'all':
      return true;

    case 'ifcType': {
      if (!criterion.ifcTypes || criterion.ifcTypes.length === 0) {
        return true;
      }

      const typesToMatch = criterion.includeSubtypes
        ? criterion.ifcTypes.flatMap((t) => [t, ...getIfcSubtypes(t)])
        : criterion.ifcTypes;

      return typesToMatch.some(
        (t) => t.toLowerCase() === element.ifcType.toLowerCase()
      );
    }

    case 'property': {
      if (!criterion.propertyName) return false;

      const operator = criterion.operator || 'equals';
      let actualValue: unknown;

      if (criterion.propertySet && element.properties) {
        const pset = element.properties[criterion.propertySet];
        actualValue = pset?.[criterion.propertyName];
      } else if (element.properties) {
        // Search all property sets
        for (const pset of Object.values(element.properties)) {
          if (criterion.propertyName in pset) {
            actualValue = pset[criterion.propertyName];
            break;
          }
        }
      }

      return evaluateOperator(actualValue, operator, criterion.value);
    }

    case 'propertySet': {
      if (!criterion.propertySet || !element.properties) {
        return criterion.operator === 'notExists';
      }

      const exists = criterion.propertySet in element.properties;
      const operator = criterion.operator || 'exists';

      if (operator === 'exists') return exists;
      if (operator === 'notExists') return !exists;

      return exists;
    }

    case 'material': {
      if (!criterion.materialNames || !element.materials) {
        return false;
      }

      return criterion.materialNames.some((pattern) =>
        element.materials!.some((m) =>
          m.toLowerCase().includes(pattern.toLowerCase())
        )
      );
    }

    case 'layer': {
      if (!criterion.layerNames || !element.layers) {
        return false;
      }

      return criterion.layerNames.some((pattern) =>
        element.layers!.some((l) =>
          l.toLowerCase().includes(pattern.toLowerCase())
        )
      );
    }

    case 'expressId': {
      if (!criterion.expressIds) return false;
      return criterion.expressIds.includes(element.expressId);
    }

    case 'modelId': {
      if (!criterion.modelIds || !element.modelId) return false;
      return criterion.modelIds.includes(element.modelId);
    }

    default:
      return false;
  }
}

/**
 * Check if an object is compound criteria
 */
function isCompoundCriteria(
  criteria: OverrideCriteria | OverrideCriterion
): criteria is OverrideCriteria {
  return 'logic' in criteria && 'conditions' in criteria;
}

/**
 * Evaluate criteria (simple or compound) against element data
 */
function evaluateCriteria(
  criteria: OverrideCriteria | OverrideCriterion,
  element: ElementData
): boolean {
  if (isCompoundCriteria(criteria)) {
    const results = criteria.conditions.map((c) => evaluateCriteria(c, element));

    if (criteria.logic === 'and') {
      return results.every(Boolean);
    } else {
      return results.some(Boolean);
    }
  }

  return evaluateCriterion(criteria, element);
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve line weight to mm value
 */
function resolveLineWeight(weight: LineWeightPreset | number | undefined): number {
  if (weight === undefined) return DEFAULT_STYLE.lineWeight;
  if (typeof weight === 'number') return weight;
  const value = LINE_WEIGHT_VALUES[weight as LineWeightPreset];
  return value !== undefined ? value : DEFAULT_STYLE.lineWeight;
}

/**
 * Resolve dash pattern to array
 */
function resolveDashPattern(style: LineStylePreset | DashPattern | undefined): number[] {
  if (style === undefined) return DEFAULT_STYLE.dashPattern;

  if (typeof style === 'string') {
    return DASH_PATTERNS[style] ?? DEFAULT_STYLE.dashPattern;
  }

  if (style.custom) {
    return style.custom;
  }

  if (style.preset) {
    return DASH_PATTERNS[style.preset] ?? DEFAULT_STYLE.dashPattern;
  }

  return DEFAULT_STYLE.dashPattern;
}

/**
 * Merge a partial style into a resolved style
 */
function mergeStyle(base: ResolvedGraphicStyle, override: GraphicStyle): ResolvedGraphicStyle {
  return {
    fillColor: override.fillColor ?? base.fillColor,
    strokeColor: override.strokeColor ?? base.strokeColor,
    backgroundColor: override.backgroundColor ?? base.backgroundColor,
    lineWeight: override.lineWeight !== undefined ? resolveLineWeight(override.lineWeight) : base.lineWeight,
    lineCap: override.lineCap ?? base.lineCap,
    lineJoin: override.lineJoin ?? base.lineJoin,
    dashPattern: override.lineStyle ? resolveDashPattern(override.lineStyle) : base.dashPattern,
    hatchPattern: override.hatchPattern ?? base.hatchPattern,
    hatchSpacing: override.hatchSpacing ?? base.hatchSpacing,
    hatchAngle: override.hatchAngle ?? base.hatchAngle,
    hatchSecondaryAngle: override.hatchSecondaryAngle ?? base.hatchSecondaryAngle,
    hatchColor: override.hatchColor ?? base.hatchColor,
    hatchLineWeight: override.hatchLineWeight ?? base.hatchLineWeight,
    visible: override.visible ?? base.visible,
    opacity: override.opacity ?? base.opacity,
    drawOrder: override.drawOrder ?? base.drawOrder,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RULE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class GraphicOverrideEngine {
  private rules: GraphicOverrideRule[] = [];

  constructor(rules?: GraphicOverrideRule[]) {
    if (rules) {
      this.setRules(rules);
    }
  }

  /**
   * Set the active rules
   */
  setRules(rules: GraphicOverrideRule[]): void {
    // Sort by priority (ascending - lower priority applied first)
    this.rules = [...rules].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Add a rule
   */
  addRule(rule: GraphicOverrideRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a rule by ID
   */
  removeRule(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  /**
   * Get all active rules
   */
  getRules(): GraphicOverrideRule[] {
    return [...this.rules];
  }

  /**
   * Apply overrides to an element and get resolved style
   */
  applyOverrides(element: ElementData, baseStyle?: Partial<GraphicStyle>): OverrideResult {
    // Start with default style merged with any base style
    let resolvedStyle: ResolvedGraphicStyle = baseStyle
      ? mergeStyle(DEFAULT_STYLE, baseStyle)
      : { ...DEFAULT_STYLE };

    const matchedRules: GraphicOverrideRule[] = [];

    // Apply rules in priority order
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (evaluateCriteria(rule.criteria, element)) {
        resolvedStyle = mergeStyle(resolvedStyle, rule.style);
        matchedRules.push(rule);
      }
    }

    return {
      element,
      style: resolvedStyle,
      matchedRules,
    };
  }

  /**
   * Apply overrides to multiple elements
   */
  applyOverridesToMany(
    elements: ElementData[],
    baseStyles?: Map<number, Partial<GraphicStyle>>
  ): Map<number, OverrideResult> {
    const results = new Map<number, OverrideResult>();

    for (const element of elements) {
      const baseStyle = baseStyles?.get(element.expressId);
      results.set(element.expressId, this.applyOverrides(element, baseStyle));
    }

    return results;
  }

  /**
   * Check which rules match an element (for debugging/preview)
   */
  getMatchingRules(element: ElementData): GraphicOverrideRule[] {
    return this.rules.filter(
      (rule) => rule.enabled && evaluateCriteria(rule.criteria, element)
    );
  }

  /**
   * Validate a rule's criteria syntax
   */
  static validateCriteria(criteria: OverrideCriteria | OverrideCriterion): string[] {
    const errors: string[] = [];

    if (isCompoundCriteria(criteria)) {
      if (!criteria.conditions || criteria.conditions.length === 0) {
        errors.push('Compound criteria must have at least one condition');
      }
      for (const condition of criteria.conditions) {
        errors.push(...GraphicOverrideEngine.validateCriteria(condition));
      }
    } else {
      if (!criteria.type) {
        errors.push('Criterion must have a type');
      }

      if (criteria.type === 'property' && !criteria.propertyName) {
        errors.push('Property criterion requires propertyName');
      }

      if (criteria.type === 'ifcType' && (!criteria.ifcTypes || criteria.ifcTypes.length === 0)) {
        errors.push('IFC type criterion requires at least one type');
      }
    }

    return errors;
  }
}

/**
 * Create a default override engine
 */
export function createOverrideEngine(rules?: GraphicOverrideRule[]): GraphicOverrideEngine {
  return new GraphicOverrideEngine(rules);
}

/**
 * Helper to create a simple IFC type criterion
 */
export function ifcTypeCriterion(types: string[], includeSubtypes = true): OverrideCriterion {
  return {
    type: 'ifcType',
    ifcTypes: types,
    includeSubtypes,
  };
}

/**
 * Helper to create a property criterion
 */
export function propertyCriterion(
  propertyName: string,
  operator: CriteriaOperator,
  value?: unknown,
  propertySet?: string
): OverrideCriterion {
  return {
    type: 'property',
    propertyName,
    propertySet,
    operator,
    value: value as string | number | boolean,
  };
}

/**
 * Helper to combine criteria with AND
 */
export function andCriteria(
  ...conditions: (OverrideCriteria | OverrideCriterion)[]
): OverrideCriteria {
  return { logic: 'and', conditions };
}

/**
 * Helper to combine criteria with OR
 */
export function orCriteria(
  ...conditions: (OverrideCriteria | OverrideCriterion)[]
): OverrideCriteria {
  return { logic: 'or', conditions };
}
