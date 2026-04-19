/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Object Styles — Revit-like per-category graphic configuration for 2D views.
 *
 * This is the single source of truth for how every IFC element category looks
 * in a 2D drawing (floor plan, section, elevation).  Both the mesh-based
 * SVGExporter and the BubbleGraph SVG plan renderer consume this config.
 *
 * Terminology follows Revit's "Object Styles" dialog:
 *   - Cut Lines      : pen weight/color/pattern for elements sliced by section plane
 *   - Projection Lines: pen weight/color/pattern for elements visible but below/above cut
 *   - Fill Pattern   : hatch applied to the cut section face
 */

import type { HatchPatternType } from './styles.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type LinePatternPreset = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'center';

export interface ObjectStyleLineProps {
  /** Pen weight in mm (AutoCAD equivalent: 0.4 ≈ "medium-heavy") */
  lineWeight: number;
  /** Stroke color in hex (#RRGGBB) */
  lineColor: string;
  /** Line dash pattern */
  linePattern: LinePatternPreset;
}

export interface ObjectStyleHatch {
  /** SVG / architectural hatch pattern type */
  pattern: HatchPatternType;
  /** Spacing between hatch lines in mm at 1:1 scale */
  spacing: number;
  /** Primary angle in degrees */
  angle: number;
  /** Secondary angle for cross-hatch patterns */
  secondaryAngle?: number;
  /** Hatch line color */
  lineColor: string;
  /** Hatch line weight in mm */
  lineWeight: number;
}

/**
 * Full graphic style for one IFC element category.
 * Optional fields fall back to `DEFAULT_OBJECT_STYLES['_default']`.
 */
export interface ObjectStyle {
  /** Human-readable label (used in the Object Styles UI table) */
  label: string;
  /** Whether this category appears in 2D views at all */
  visible: boolean;
  /** Cut-plane line style (elements intersected by the section plane) */
  cutLines: ObjectStyleLineProps;
  /** Below-cut projection line style */
  projectionLines: ObjectStyleLineProps;
  /** Solid fill color for the cut polygon face. null = transparent */
  fillColor: string | null;
  /** Hatch/pattern overlay applied on top of the fill. null = no hatch */
  hatch: ObjectStyleHatch | null;
}

/**
 * Complete per-IFC-type object styles map.
 * Keys are IFC PascalCase type names (e.g. "IfcColumn").
 * Use "_default" key for the global fallback.
 */
export type ObjectStylesConfig = Record<string, ObjectStyle>;

/** Per-style partial override accepted by the deep-merge in resolveObjectStyle. */
export type ObjectStyleOverride =
  Partial<Omit<ObjectStyle, 'cutLines' | 'projectionLines' | 'hatch'>> & {
    cutLines?: Partial<ObjectStyleLineProps>;
    projectionLines?: Partial<ObjectStyleLineProps>;
    hatch?: Partial<ObjectStyleHatch> | null;
  };

/** Map of partial per-type overrides passed into resolve / visibility helpers. */
export type ObjectStyleOverrides = Partial<Record<string, ObjectStyleOverride>>;

// ═══════════════════════════════════════════════════════════════════════════
// DASH-PATTERN LOOKUP
// ═══════════════════════════════════════════════════════════════════════════

/** SVG stroke-dasharray values (mm) for each line pattern preset */
export const LINE_PATTERN_DASH_ARRAYS: Record<LinePatternPreset, number[]> = {
  solid: [],
  dashed: [2, 1],
  dotted: [0.5, 0.5],
  dashdot: [3, 1, 0.5, 1],
  center: [6, 1, 1, 1],
};

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT OBJECT STYLES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Architectural drawing standards.
 * Line weights follow ISO 128 / common CAD pen conventions.
 * Column: 0.4 mm = "medium-heavy" pen (as requested).
 */
export const DEFAULT_OBJECT_STYLES: ObjectStylesConfig = {

  // ── Global fallback ──────────────────────────────────────────────────────
  _default: {
    label: 'Default',
    visible: true,
    cutLines:        { lineWeight: 0.25, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#666666', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 4.0, angle: 45, lineColor: '#666666', lineWeight: 0.13 },
  },

  // ── Structural ────────────────────────────────────────────────────────────

  IfcColumn: {
    label: 'Columns',
    visible: true,
    cutLines:        { lineWeight: 0.4, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#000000', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 2.5, angle: 45, lineColor: '#000000', lineWeight: 0.18 },
  },

  IfcBeam: {
    label: 'Beams',
    visible: true,
    cutLines:        { lineWeight: 0.4, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#000000', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 2.0, angle: 45, secondaryAngle: -45, lineColor: '#333333', lineWeight: 0.18 },
  },

  IfcMember: {
    label: 'Members',
    visible: true,
    cutLines:        { lineWeight: 0.35, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.18, lineColor: '#444444', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 2.5, angle: 45, lineColor: '#444444', lineWeight: 0.18 },
  },

  IfcPlate: {
    label: 'Plates',
    visible: true,
    cutLines:        { lineWeight: 0.35, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.18, lineColor: '#555555', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 1.5, angle: 45, lineColor: '#555555', lineWeight: 0.13 },
  },

  IfcFooting: {
    label: 'Footings',
    visible: true,
    cutLines:        { lineWeight: 0.5, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#777777', linePattern: 'solid' },
    fillColor: '#E8E8E8',
    hatch: { pattern: 'concrete', spacing: 3.0, angle: 0, lineColor: '#777777', lineWeight: 0.13 },
  },

  // ── Walls ─────────────────────────────────────────────────────────────────

  IfcWall: {
    label: 'Walls',
    visible: true,
    cutLines:        { lineWeight: 0.7, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.35, lineColor: '#000000', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 3.0, angle: 45, lineColor: '#000000', lineWeight: 0.18 },
  },

  IfcWallStandardCase: {
    label: 'Walls (standard)',
    visible: true,
    cutLines:        { lineWeight: 0.7, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.35, lineColor: '#000000', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: { pattern: 'diagonal', spacing: 3.0, angle: 45, lineColor: '#000000', lineWeight: 0.18 },
  },

  IfcCurtainWall: {
    label: 'Curtain Walls',
    visible: true,
    cutLines:        { lineWeight: 0.25, lineColor: '#0066CC', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#0066CC', linePattern: 'solid' },
    fillColor: null,
    hatch: null,
  },

  // ── Slabs & Roofs ─────────────────────────────────────────────────────────

  IfcSlab: {
    label: 'Slabs',
    visible: true,
    cutLines:        { lineWeight: 0.5, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#666666', linePattern: 'solid' },
    fillColor: '#E0E0E0',
    hatch: { pattern: 'concrete', spacing: 2.5, angle: 0, lineColor: '#666666', lineWeight: 0.13 },
  },

  IfcRoof: {
    label: 'Roofs',
    visible: true,
    cutLines:        { lineWeight: 0.5, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#8B4513', linePattern: 'solid' },
    fillColor: '#F5E6D3',
    hatch: { pattern: 'cross-hatch', spacing: 4.0, angle: 45, secondaryAngle: -45, lineColor: '#8B4513', lineWeight: 0.13 },
  },

  IfcCovering: {
    label: 'Coverings',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#999999', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.09, lineColor: '#999999', linePattern: 'solid' },
    fillColor: '#F5F5F5',
    hatch: { pattern: 'horizontal', spacing: 8.0, angle: 0, lineColor: '#999999', lineWeight: 0.09 },
  },

  // ── Openings & Glazing ────────────────────────────────────────────────────

  IfcWindow: {
    label: 'Windows',
    visible: true,
    cutLines:        { lineWeight: 0.25, lineColor: '#1976D2', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.18, lineColor: '#1976D2', linePattern: 'solid' },
    fillColor: '#C8E6FF',
    hatch: null,
  },

  IfcDoor: {
    label: 'Doors',
    visible: true,
    cutLines:        { lineWeight: 0.35, lineColor: '#000000', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#000000', linePattern: 'solid' },
    fillColor: '#FFFFFF',
    hatch: null,
  },

  /**
   * IfcOpeningElement — hidden by default in 2D per the project requirement.
   * The drawing generator will also filter these out from the mesh pipeline.
   */
  IfcOpeningElement: {
    label: 'Opening Elements',
    visible: false,
    cutLines:        { lineWeight: 0.13, lineColor: '#CCCCCC', linePattern: 'dashed' },
    projectionLines: { lineWeight: 0.09, lineColor: '#CCCCCC', linePattern: 'dashed' },
    fillColor: null,
    hatch: null,
  },

  // ── Stairs & Circulation ──────────────────────────────────────────────────

  IfcStair: {
    label: 'Stairs',
    visible: true,
    cutLines:        { lineWeight: 0.35, lineColor: '#444444', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#444444', linePattern: 'solid' },
    fillColor: '#FAFAFA',
    hatch: { pattern: 'horizontal', spacing: 5.0, angle: 0, lineColor: '#444444', lineWeight: 0.13 },
  },

  IfcStairFlight: {
    label: 'Stair Flights',
    visible: true,
    cutLines:        { lineWeight: 0.35, lineColor: '#444444', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.25, lineColor: '#444444', linePattern: 'solid' },
    fillColor: '#FAFAFA',
    hatch: { pattern: 'horizontal', spacing: 5.0, angle: 0, lineColor: '#444444', lineWeight: 0.13 },
  },

  IfcRamp: {
    label: 'Ramps',
    visible: true,
    cutLines:        { lineWeight: 0.25, lineColor: '#555555', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.18, lineColor: '#555555', linePattern: 'solid' },
    fillColor: '#F0F0F0',
    hatch: { pattern: 'diagonal', spacing: 6.0, angle: 30, lineColor: '#555555', lineWeight: 0.13 },
  },

  IfcRailing: {
    label: 'Railings',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#666666', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#666666', linePattern: 'solid' },
    fillColor: null,
    hatch: null,
  },

  // ── MEP ───────────────────────────────────────────────────────────────────

  IfcFlowTerminal: {
    label: 'Flow Terminals',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#0066AA', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#0066AA', linePattern: 'solid' },
    fillColor: null,
    hatch: null,
  },

  IfcFlowSegment: {
    label: 'Flow Segments (pipes/ducts)',
    visible: true,
    cutLines:        { lineWeight: 0.25, lineColor: '#0066AA', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.18, lineColor: '#0066AA', linePattern: 'solid' },
    fillColor: null,
    hatch: null,
  },

  IfcDistributionElement: {
    label: 'Distribution Elements',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#006688', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#006688', linePattern: 'solid' },
    fillColor: null,
    hatch: null,
  },

  // ── Spaces & Furnishing ───────────────────────────────────────────────────

  IfcSpace: {
    label: 'Spaces',
    visible: true,
    cutLines:        { lineWeight: 0.09, lineColor: '#CCCCCC', linePattern: 'dashed' },
    projectionLines: { lineWeight: 0.09, lineColor: '#CCCCCC', linePattern: 'dashed' },
    fillColor: null,
    hatch: null,
  },

  IfcFurnishingElement: {
    label: 'Furnishing',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#888888', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#888888', linePattern: 'solid' },
    fillColor: '#F8F8F8',
    hatch: null,
  },

  IfcFurniture: {
    label: 'Furniture',
    visible: true,
    cutLines:        { lineWeight: 0.18, lineColor: '#888888', linePattern: 'solid' },
    projectionLines: { lineWeight: 0.13, lineColor: '#888888', linePattern: 'solid' },
    fillColor: '#F8F8F8',
    hatch: null,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the effective ObjectStyle for an IFC type, merging user overrides
 * on top of the built-in defaults.
 *
 * Resolution order (highest priority last wins):
 *   _default → per-type default → per-type user override
 */
export function resolveObjectStyle(
  ifcType: string,
  userOverrides: ObjectStyleOverrides = {},
): ObjectStyle {
  const fallback = DEFAULT_OBJECT_STYLES['_default'];
  const typeDefault = DEFAULT_OBJECT_STYLES[ifcType] ?? fallback;
  const userOverride = userOverrides[ifcType];

  if (!userOverride) return typeDefault;

  // Deep-merge: top-level fields + nested objects
  return {
    ...typeDefault,
    ...userOverride,
    cutLines: { ...typeDefault.cutLines, ...userOverride.cutLines },
    projectionLines: { ...typeDefault.projectionLines, ...userOverride.projectionLines },
    hatch:
      userOverride.hatch !== undefined
        ? userOverride.hatch === null
          ? null
          : { ...(typeDefault.hatch ?? DEFAULT_OBJECT_STYLES['_default'].hatch!), ...userOverride.hatch }
        : typeDefault.hatch,
  };
}

/**
 * Returns true when an IFC type should be included in the 2D drawing,
 * taking user overrides into account.
 */
export function isIfcTypeVisible(
  ifcType: string,
  userOverrides: ObjectStyleOverrides = {},
): boolean {
  return resolveObjectStyle(ifcType, userOverrides).visible;
}

/**
 * Collect all IFC types that are currently invisible so callers can filter
 * meshes before passing them to the drawing generator.
 */
export function getHiddenIfcTypes(
  userOverrides: ObjectStyleOverrides = {},
): string[] {
  const allTypes = new Set([
    ...Object.keys(DEFAULT_OBJECT_STYLES),
    ...Object.keys(userOverrides),
  ]);
  allTypes.delete('_default');

  return [...allTypes].filter((t) => !isIfcTypeVisible(t, userOverrides));
}
