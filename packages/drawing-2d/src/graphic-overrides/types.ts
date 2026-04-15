/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Graphic Overrides Types
 *
 * Defines the data model for parametric graphic overrides in 2D drawings.
 * Allows users to customize colors, line weights, hatches based on
 * IFC types, properties, or custom criteria.
 */

import type { HatchPatternType } from '../styles.js';

// ═══════════════════════════════════════════════════════════════════════════
// LINE PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════

export type LineWeightPreset = 'heavy' | 'medium' | 'light' | 'hairline';
export type LineStylePreset = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'center';

export interface DashPattern {
  /** Pattern name for presets */
  preset?: LineStylePreset;
  /** Custom dash array [dash, gap, ...] in mm */
  custom?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITERIA - What elements to match
// ═══════════════════════════════════════════════════════════════════════════

export type CriteriaOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterOrEqual'
  | 'lessOrEqual'
  | 'exists'
  | 'notExists'
  | 'in'
  | 'notIn';

export type CriteriaType =
  | 'ifcType'
  | 'property'
  | 'propertySet'
  | 'material'
  | 'layer'
  | 'expressId'
  | 'modelId'
  | 'all';

/**
 * Single criterion for matching elements
 */
export interface OverrideCriterion {
  /** Type of criterion */
  type: CriteriaType;

  // ─── IFC Type matching ─────────────────────────────────────────────────────
  /** IFC types to match (for type='ifcType') */
  ifcTypes?: string[];
  /** Include subtypes (e.g., IfcWall includes IfcWallStandardCase) */
  includeSubtypes?: boolean;

  // ─── Property matching ─────────────────────────────────────────────────────
  /** Property set name (for type='property' or 'propertySet') */
  propertySet?: string;
  /** Property name (for type='property') */
  propertyName?: string;
  /** Comparison operator */
  operator?: CriteriaOperator;
  /** Value to compare against */
  value?: string | number | boolean | string[] | number[];

  // ─── Material matching ─────────────────────────────────────────────────────
  /** Material name patterns (for type='material') */
  materialNames?: string[];

  // ─── Layer matching ────────────────────────────────────────────────────────
  /** Layer/presentation layer names (for type='layer') */
  layerNames?: string[];

  // ─── ID matching ───────────────────────────────────────────────────────────
  /** Express IDs to match (for type='expressId') */
  expressIds?: number[];
  /** Model IDs to match (for type='modelId') */
  modelIds?: string[];
}

/**
 * Compound criteria with logical operators
 */
export interface OverrideCriteria {
  /** Logical operator for combining conditions */
  logic: 'and' | 'or';
  /** List of conditions */
  conditions: (OverrideCriterion | OverrideCriteria)[];
}

// ═══════════════════════════════════════════════════════════════════════════
// GRAPHIC STYLE - What to apply
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete graphic style that can be applied to elements
 */
export interface GraphicStyle {
  // ─── Colors ────────────────────────────────────────────────────────────────
  /** Fill color for cut polygons (hex with optional alpha: #RRGGBB or #RRGGBBAA) */
  fillColor?: string;
  /** Stroke/line color (hex) */
  strokeColor?: string;
  /** Background color for patterns */
  backgroundColor?: string;

  // ─── Line Properties ───────────────────────────────────────────────────────
  /** Line weight (preset name or custom mm value) */
  lineWeight?: LineWeightPreset | number;
  /** Line style (dash pattern) */
  lineStyle?: LineStylePreset | DashPattern;
  /** Line cap style */
  lineCap?: 'butt' | 'round' | 'square';
  /** Line join style */
  lineJoin?: 'miter' | 'round' | 'bevel';

  // ─── Hatching ──────────────────────────────────────────────────────────────
  /** Hatch pattern type */
  hatchPattern?: HatchPatternType;
  /** Hatch line spacing in mm */
  hatchSpacing?: number;
  /** Hatch angle in degrees */
  hatchAngle?: number;
  /** Secondary hatch angle for cross-hatch */
  hatchSecondaryAngle?: number;
  /** Hatch line color */
  hatchColor?: string;
  /** Hatch line weight in mm */
  hatchLineWeight?: number;

  // ─── Visibility ────────────────────────────────────────────────────────────
  /** Whether element is visible */
  visible?: boolean;
  /** Opacity (0-1) */
  opacity?: number;

  // ─── Print Priority ────────────────────────────────────────────────────────
  /** Z-order for overlapping elements (higher = on top) */
  drawOrder?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERRIDE RULE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete override rule combining criteria and style
 */
export interface GraphicOverrideRule {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Whether rule is active */
  enabled: boolean;
  /** Priority (higher = applied later, wins conflicts) */
  priority: number;
  /** Match criteria */
  criteria: OverrideCriteria | OverrideCriterion;
  /** Style to apply */
  style: GraphicStyle;
  /** Category for organization */
  category?: string;
  /** Tags for filtering */
  tags?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PRESETS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Named collection of override rules
 */
export interface GraphicOverridePreset {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description?: string;
  /** Icon name or emoji */
  icon?: string;
  /** List of rules in this preset */
  rules: GraphicOverrideRule[];
  /** Whether this is a built-in preset */
  builtIn?: boolean;
  /** Category (e.g., "Safety", "Structural", "MEP") */
  category?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ELEMENT DATA (for rule matching)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Element data used for matching override rules
 */
export interface ElementData {
  /** Express ID */
  expressId: number;
  /** Model ID (for federation) */
  modelId?: string;
  /** IFC type (e.g., 'IfcWall') */
  ifcType: string;
  /** Properties organized by property set */
  properties?: Record<string, Record<string, unknown>>;
  /** Material names */
  materials?: string[];
  /** Layer/presentation layer assignments */
  layers?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// RESOLVED STYLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fully resolved style with all defaults filled in
 * Note: lineWeight is resolved to a number (mm), not a preset name
 */
export interface ResolvedGraphicStyle {
  /** Fill color for cut polygons (hex) */
  fillColor: string;
  /** Stroke/line color (hex) */
  strokeColor: string;
  /** Background color for patterns */
  backgroundColor: string;
  /** Line weight in mm (resolved from preset or custom) */
  lineWeight: number;
  /** Line cap style */
  lineCap: 'butt' | 'round' | 'square';
  /** Line join style */
  lineJoin: 'miter' | 'round' | 'bevel';
  /** Resolved dash pattern as array [dash, gap, ...] in mm */
  dashPattern: number[];
  /** Hatch pattern type */
  hatchPattern: HatchPatternType;
  /** Hatch line spacing in mm */
  hatchSpacing: number;
  /** Hatch angle in degrees */
  hatchAngle: number;
  /** Secondary hatch angle for cross-hatch */
  hatchSecondaryAngle: number;
  /** Hatch line color */
  hatchColor: string;
  /** Hatch line weight in mm */
  hatchLineWeight: number;
  /** Whether element is visible */
  visible: boolean;
  /** Opacity (0-1) */
  opacity: number;
  /** Z-order for overlapping elements */
  drawOrder: number;
}

/**
 * Result of applying overrides to an element
 */
export interface OverrideResult {
  /** The element data */
  element: ElementData;
  /** Resolved style */
  style: ResolvedGraphicStyle;
  /** Rules that matched (in order of application) */
  matchedRules: GraphicOverrideRule[];
}
