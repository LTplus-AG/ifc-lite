/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line weight assignment for architectural drawings
 *
 * Implements standard architectural line weight hierarchy:
 * - Heavy: Cut lines through structural elements (walls, columns, slabs)
 * - Medium: Cut lines through non-structural, opening frames
 * - Light: Projection lines, furniture
 * - Hairline: Symbols, annotations, hidden lines
 */

import type {
  DrawingLine,
  ArchitecturalLine,
  LineWeight,
  LineStyle,
  SemanticLineType,
  LineCategory,
} from '../types.js';

/**
 * Line weight configuration with actual widths
 */
export const LINE_WEIGHT_CONFIG: Record<LineWeight, { widthMm: number; widthPx: number }> = {
  heavy: { widthMm: 0.5, widthPx: 2 },
  medium: { widthMm: 0.35, widthPx: 1.4 },
  light: { widthMm: 0.25, widthPx: 1 },
  hairline: { widthMm: 0.18, widthPx: 0.7 },
};

/**
 * IFC type to line weight mapping for cut lines
 */
export const IFC_TYPE_WEIGHTS: Record<string, LineWeight> = {
  // Structural - heavy
  IfcWall: 'heavy',
  IfcWallStandardCase: 'heavy',
  IfcColumn: 'heavy',
  IfcBeam: 'heavy',
  IfcSlab: 'heavy',
  IfcFooting: 'heavy',
  IfcPile: 'heavy',
  IfcRoof: 'heavy',

  // Semi-structural - medium
  IfcStair: 'medium',
  IfcStairFlight: 'medium',
  IfcRamp: 'medium',
  IfcRampFlight: 'medium',
  IfcRailing: 'medium',
  IfcCurtainWall: 'medium',

  // Openings - medium
  IfcDoor: 'medium',
  IfcWindow: 'medium',
  IfcOpeningElement: 'light',

  // Non-structural - light
  IfcCovering: 'light',
  IfcFurnishingElement: 'light',
  IfcFurniture: 'light',
  IfcBuildingElementProxy: 'light',
  IfcDistributionElement: 'light',
  IfcFlowTerminal: 'light',
  IfcFlowSegment: 'light',

  // Spaces - hairline
  IfcSpace: 'hairline',
  IfcZone: 'hairline',
};

/**
 * Category to base weight mapping
 */
const CATEGORY_WEIGHTS: Record<LineCategory, LineWeight> = {
  cut: 'heavy',
  projection: 'light',
  hidden: 'hairline',
  silhouette: 'medium',
  crease: 'light',
  boundary: 'light',
  annotation: 'hairline',
};

/**
 * Category to line style mapping
 */
const CATEGORY_STYLES: Record<LineCategory, LineStyle> = {
  cut: 'solid',
  projection: 'solid',
  hidden: 'dashed',
  silhouette: 'solid',
  crease: 'solid',
  boundary: 'solid',
  annotation: 'solid',
};

/**
 * Assigns line weights and styles to drawing lines
 */
export class LineWeightAssigner {
  private ifcTypeWeights: Record<string, LineWeight>;

  constructor(customWeights?: Record<string, LineWeight>) {
    this.ifcTypeWeights = { ...IFC_TYPE_WEIGHTS, ...customWeights };
  }

  /**
   * Assign weight and style to a drawing line
   */
  assignWeight(line: DrawingLine): ArchitecturalLine {
    const baseWeight = this.getBaseWeight(line);
    const lineStyle = this.getLineStyle(line);
    const semanticType = this.getSemanticType(line);

    return {
      ...line,
      lineWeight: baseWeight,
      lineStyle,
      semanticType,
    };
  }

  /**
   * Process all lines in a drawing
   */
  processLines(lines: DrawingLine[]): ArchitecturalLine[] {
    return lines.map((line) => this.assignWeight(line));
  }

  /**
   * Get the base weight for a line
   */
  private getBaseWeight(line: DrawingLine): LineWeight {
    // Cut lines use IFC type-based weight
    if (line.category === 'cut') {
      return this.ifcTypeWeights[line.ifcType] ?? CATEGORY_WEIGHTS.cut;
    }

    // Hidden lines are always hairline
    if (line.visibility === 'hidden' || line.category === 'hidden') {
      return 'hairline';
    }

    // Other categories use their base weight
    return CATEGORY_WEIGHTS[line.category] ?? 'light';
  }

  /**
   * Get the line style
   */
  private getLineStyle(line: DrawingLine): LineStyle {
    if (line.visibility === 'hidden' || line.category === 'hidden') {
      return 'dashed';
    }
    return CATEGORY_STYLES[line.category] ?? 'solid';
  }

  /**
   * Determine semantic type for layer assignment
   */
  private getSemanticType(line: DrawingLine): SemanticLineType {
    const { category, ifcType, visibility } = line;

    if (visibility === 'hidden') {
      return 'hidden';
    }

    if (category === 'cut') {
      const upper = ifcType.toUpperCase();
      if (upper.includes('WALL')) return 'wall-cut';
      if (upper.includes('COLUMN')) return 'column-cut';
      if (upper.includes('SLAB') || upper.includes('FLOOR')) return 'slab-cut';
      if (upper.includes('STAIR')) return 'stair-cut';
      if (upper.includes('DOOR')) return 'opening-frame';
      if (upper.includes('WINDOW')) return 'window-frame';
      return 'wall-cut';
    }

    if (category === 'projection') {
      const upper = ifcType.toUpperCase();
      if (upper.includes('WALL')) return 'wall-projection';
      if (upper.includes('FURNISH') || upper.includes('FURNITURE')) return 'furniture';
      if (upper.includes('EQUIPMENT')) return 'equipment';
      return 'wall-projection';
    }

    if (category === 'annotation') {
      return 'annotation';
    }

    return 'wall-projection';
  }

  /**
   * Get the actual width in mm for a weight
   */
  getWidthMm(weight: LineWeight): number {
    return LINE_WEIGHT_CONFIG[weight].widthMm;
  }

  /**
   * Get the actual width in pixels for a weight (at 96 DPI)
   */
  getWidthPx(weight: LineWeight): number {
    return LINE_WEIGHT_CONFIG[weight].widthPx;
  }
}

/**
 * Create a default line weight assigner
 */
export function createLineWeightAssigner(
  customWeights?: Record<string, LineWeight>
): LineWeightAssigner {
  return new LineWeightAssigner(customWeights);
}
