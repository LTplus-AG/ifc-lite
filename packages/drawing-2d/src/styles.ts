/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing Styles - Hatch patterns and line styles for architectural drawings
 *
 * Based on ISO 128-50 and common CAD conventions for BIM drawings.
 */

import type { LineCategory } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// HATCH PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

export type HatchPatternType =
  | 'solid'
  | 'diagonal'
  | 'cross-hatch'
  | 'horizontal'
  | 'vertical'
  | 'brick'
  | 'concrete'
  | 'insulation'
  | 'earth'
  | 'wood'
  | 'steel'
  | 'glass'
  | 'none';

export interface HatchPattern {
  /** Pattern type */
  type: HatchPatternType;
  /** Line spacing in mm at 1:1 scale */
  spacing: number;
  /** Primary angle in degrees */
  angle: number;
  /** Line weight in mm */
  lineWeight: number;
  /** Line color (hex) */
  strokeColor: string;
  /** Fill color for solid fills (hex with alpha) */
  fillColor?: string;
  /** Secondary angle for cross-hatch patterns */
  secondaryAngle?: number;
}

/**
 * ISO 128-50 / BS 1192 standard architectural hatch patterns
 * Maps IFC types to appropriate patterns
 */
export const HATCH_PATTERNS: Record<string, HatchPattern> = {
  // ─────────────────────────────────────────────────────────────────────────
  // WALLS
  // ─────────────────────────────────────────────────────────────────────────
  IfcWall: {
    type: 'diagonal',
    spacing: 3.0,
    angle: 45,
    lineWeight: 0.18,
    strokeColor: '#000000',
  },
  IfcWallStandardCase: {
    type: 'diagonal',
    spacing: 3.0,
    angle: 45,
    lineWeight: 0.18,
    strokeColor: '#000000',
  },
  IfcCurtainWall: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#0066CC',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SLABS & FLOORS
  // ─────────────────────────────────────────────────────────────────────────
  IfcSlab: {
    type: 'concrete',
    spacing: 2.5,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#666666',
  },
  IfcRoof: {
    type: 'cross-hatch',
    spacing: 4.0,
    angle: 45,
    secondaryAngle: -45,
    lineWeight: 0.13,
    strokeColor: '#8B4513',
  },
  IfcCovering: {
    type: 'horizontal',
    spacing: 8.0,
    angle: 0,
    lineWeight: 0.09,
    strokeColor: '#999999',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // STRUCTURAL
  // ─────────────────────────────────────────────────────────────────────────
  IfcColumn: {
    type: 'steel',
    spacing: 2.0,
    angle: 45,
    lineWeight: 0.25,
    strokeColor: '#333333',
  },
  IfcBeam: {
    type: 'steel',
    spacing: 2.0,
    angle: 45,
    lineWeight: 0.25,
    strokeColor: '#333333',
  },
  IfcMember: {
    type: 'diagonal',
    spacing: 2.5,
    angle: 45,
    lineWeight: 0.18,
    strokeColor: '#444444',
  },
  IfcPlate: {
    type: 'steel',
    spacing: 1.5,
    angle: 45,
    lineWeight: 0.18,
    strokeColor: '#555555',
  },
  IfcFooting: {
    type: 'concrete',
    spacing: 3.0,
    angle: 0,
    lineWeight: 0.18,
    strokeColor: '#777777',
  },
  IfcPile: {
    type: 'concrete',
    spacing: 2.5,
    angle: 0,
    lineWeight: 0.18,
    strokeColor: '#666666',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // OPENINGS
  // ─────────────────────────────────────────────────────────────────────────
  IfcWindow: {
    type: 'glass',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#0099CC',
    fillColor: 'rgba(200, 230, 255, 0.3)',
  },
  IfcDoor: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.25,
    strokeColor: '#000000',
  },
  IfcOpeningElement: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#CCCCCC',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // STAIRS & CIRCULATION
  // ─────────────────────────────────────────────────────────────────────────
  IfcStair: {
    type: 'horizontal',
    spacing: 5.0,
    angle: 0,
    lineWeight: 0.18,
    strokeColor: '#444444',
  },
  IfcStairFlight: {
    type: 'horizontal',
    spacing: 5.0,
    angle: 0,
    lineWeight: 0.18,
    strokeColor: '#444444',
  },
  IfcRamp: {
    type: 'diagonal',
    spacing: 6.0,
    angle: 30,
    lineWeight: 0.13,
    strokeColor: '#555555',
  },
  IfcRailing: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#666666',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // MEP
  // ─────────────────────────────────────────────────────────────────────────
  IfcFlowTerminal: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#0066AA',
  },
  IfcFlowSegment: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.18,
    strokeColor: '#0066AA',
  },
  IfcDistributionElement: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#006688',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SPACES & FURNISHING
  // ─────────────────────────────────────────────────────────────────────────
  IfcSpace: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.09,
    strokeColor: '#CCCCCC',
  },
  IfcFurnishingElement: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#888888',
  },
  IfcFurniture: {
    type: 'none',
    spacing: 0,
    angle: 0,
    lineWeight: 0.13,
    strokeColor: '#888888',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT
  // ─────────────────────────────────────────────────────────────────────────
  default: {
    type: 'diagonal',
    spacing: 4.0,
    angle: 45,
    lineWeight: 0.13,
    strokeColor: '#666666',
  },
};

/**
 * Get hatch pattern for an IFC type
 */
export function getHatchPattern(ifcType: string): HatchPattern {
  return HATCH_PATTERNS[ifcType] || HATCH_PATTERNS['default'];
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE STYLES
// ═══════════════════════════════════════════════════════════════════════════

export interface LineStyle {
  /** Line weight in mm */
  weight: number;
  /** Stroke color (hex) */
  color: string;
  /** Dash pattern [dash, gap, ...] in mm. Empty = solid */
  dashPattern: number[];
  /** Line cap style */
  lineCap: 'butt' | 'round' | 'square';
  /** Line join style */
  lineJoin: 'miter' | 'round' | 'bevel';
}

/**
 * ISO 128 standard line weights and styles by category
 */
export const LINE_STYLES: Record<LineCategory, LineStyle> = {
  cut: {
    weight: 0.5,
    color: '#000000',
    dashPattern: [],
    lineCap: 'round',
    lineJoin: 'round',
  },
  projection: {
    weight: 0.25,
    color: '#000000',
    dashPattern: [],
    lineCap: 'round',
    lineJoin: 'round',
  },
  hidden: {
    weight: 0.18,
    color: '#666666',
    dashPattern: [2, 1],
    lineCap: 'butt',
    lineJoin: 'round',
  },
  silhouette: {
    weight: 0.35,
    color: '#000000',
    dashPattern: [],
    lineCap: 'round',
    lineJoin: 'round',
  },
  crease: {
    weight: 0.18,
    color: '#000000',
    dashPattern: [],
    lineCap: 'round',
    lineJoin: 'round',
  },
  boundary: {
    weight: 0.25,
    color: '#000000',
    dashPattern: [],
    lineCap: 'round',
    lineJoin: 'round',
  },
  annotation: {
    weight: 0.13,
    color: '#000000',
    dashPattern: [],
    lineCap: 'butt',
    lineJoin: 'miter',
  },
};

/**
 * Per-IFC-type line weight overrides
 */
export const TYPE_LINE_WEIGHTS: Record<string, Partial<Record<LineCategory, number>>> = {
  IfcWall: { cut: 0.7, projection: 0.35 },
  IfcWallStandardCase: { cut: 0.7, projection: 0.35 },
  IfcSlab: { cut: 0.5, projection: 0.25 },
  IfcColumn: { cut: 0.5, projection: 0.35 },
  IfcBeam: { cut: 0.5, projection: 0.35 },
  IfcWindow: { cut: 0.35, projection: 0.18 },
  IfcDoor: { cut: 0.35, projection: 0.25 },
  IfcStair: { cut: 0.35, projection: 0.25 },
  IfcFurnishingElement: { cut: 0.18, projection: 0.13 },
  IfcFurniture: { cut: 0.18, projection: 0.13 },
  IfcSpace: { cut: 0.09, projection: 0.09 },
};

/**
 * Get line style for a category and optional IFC type override
 */
export function getLineStyle(category: LineCategory, ifcType?: string): LineStyle {
  const baseStyle = LINE_STYLES[category];

  if (ifcType && TYPE_LINE_WEIGHTS[ifcType]) {
    const override = TYPE_LINE_WEIGHTS[ifcType][category];
    if (override !== undefined) {
      return { ...baseStyle, weight: override };
    }
  }

  return baseStyle;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWING SCALES
// ═══════════════════════════════════════════════════════════════════════════

export interface DrawingScale {
  /** Display name */
  name: string;
  /** Scale factor (e.g., 100 for 1:100) */
  factor: number;
  /** Typical use case */
  useCase: string;
}

export const COMMON_SCALES: DrawingScale[] = [
  { name: '1:1', factor: 1, useCase: 'Full size details' },
  { name: '1:2', factor: 2, useCase: 'Large details' },
  { name: '1:5', factor: 5, useCase: 'Construction details' },
  { name: '1:10', factor: 10, useCase: 'Details' },
  { name: '1:20', factor: 20, useCase: 'Room plans, sections' },
  { name: '1:50', factor: 50, useCase: 'Floor plans, elevations' },
  { name: '1:100', factor: 100, useCase: 'Building plans' },
  { name: '1:200', factor: 200, useCase: 'Site plans' },
  { name: '1:500', factor: 500, useCase: 'Site context' },
  { name: '1:1000', factor: 1000, useCase: 'Urban context' },
];

/**
 * Get recommended scale for a given bounding box size
 */
export function getRecommendedScale(
  boundsWidth: number,
  boundsHeight: number,
  paperWidth: number = 420, // A3 landscape
  paperHeight: number = 297
): DrawingScale {
  const maxDimension = Math.max(boundsWidth, boundsHeight);

  // Find smallest scale that fits
  for (const scale of COMMON_SCALES) {
    const scaledWidth = boundsWidth / scale.factor;
    const scaledHeight = boundsHeight / scale.factor;

    if (scaledWidth <= paperWidth * 0.9 && scaledHeight <= paperHeight * 0.9) {
      return scale;
    }
  }

  return COMMON_SCALES[COMMON_SCALES.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════
// PAPER SIZES
// ═══════════════════════════════════════════════════════════════════════════

export interface PaperSize {
  name: string;
  width: number; // mm
  height: number; // mm
}

export const PAPER_SIZES: Record<string, PaperSize> = {
  A4: { name: 'A4', width: 210, height: 297 },
  A4_LANDSCAPE: { name: 'A4 Landscape', width: 297, height: 210 },
  A3: { name: 'A3', width: 297, height: 420 },
  A3_LANDSCAPE: { name: 'A3 Landscape', width: 420, height: 297 },
  A2: { name: 'A2', width: 420, height: 594 },
  A2_LANDSCAPE: { name: 'A2 Landscape', width: 594, height: 420 },
  A1: { name: 'A1', width: 594, height: 841 },
  A1_LANDSCAPE: { name: 'A1 Landscape', width: 841, height: 594 },
  A0: { name: 'A0', width: 841, height: 1189 },
  A0_LANDSCAPE: { name: 'A0 Landscape', width: 1189, height: 841 },
};
