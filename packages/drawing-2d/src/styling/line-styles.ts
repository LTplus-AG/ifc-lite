/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line style definitions for architectural drawings
 *
 * Standard architectural line styles:
 * - Solid: Cut lines, visible edges
 * - Dashed: Hidden lines (behind other objects)
 * - Centerline: Center lines, axes
 * - Phantom: Alternate positions, removed parts
 */

import type { LineStyle, ArchitecturalLine } from '../types.js';

/**
 * Dash pattern definitions (as SVG stroke-dasharray values)
 * Units are relative to line width
 */
export const DASH_PATTERNS: Record<LineStyle, string | null> = {
  solid: null,
  dashed: '4 2',        // Standard hidden line
  dotted: '1 2',        // Fine dotted
  centerline: '10 3 2 3', // Long-short-long pattern
  phantom: '8 3 2 3 2 3', // Double short dash pattern
};

/**
 * Scale factor for dash patterns based on line weight
 */
const DASH_SCALE_FACTORS: Record<string, number> = {
  heavy: 1.2,
  medium: 1.0,
  light: 0.8,
  hairline: 0.6,
};

/**
 * Line styler for generating SVG style attributes
 */
export class LineStyler {
  /**
   * Get SVG stroke-dasharray for a line
   */
  getDashArray(line: ArchitecturalLine, scale: number = 1): string | undefined {
    const pattern = DASH_PATTERNS[line.lineStyle];
    if (!pattern) return undefined;

    // Scale pattern based on line weight and drawing scale
    const weightScale = DASH_SCALE_FACTORS[line.lineWeight] ?? 1.0;
    const scaledPattern = pattern
      .split(' ')
      .map((v) => (parseFloat(v) * weightScale * scale).toFixed(2))
      .join(' ');

    return scaledPattern;
  }

  /**
   * Get SVG stroke-width for a line
   */
  getStrokeWidth(line: ArchitecturalLine, scale: number = 1): number {
    const widths: Record<string, number> = {
      heavy: 0.5,
      medium: 0.35,
      light: 0.25,
      hairline: 0.18,
    };
    return (widths[line.lineWeight] ?? 0.25) * scale;
  }

  /**
   * Get complete SVG style string for a line
   */
  getSVGStyle(line: ArchitecturalLine, scale: number = 1, color: string = '#000000'): string {
    const strokeWidth = this.getStrokeWidth(line, scale);
    const dashArray = this.getDashArray(line, scale);

    let style = `stroke="${color}" stroke-width="${strokeWidth}" fill="none"`;
    if (dashArray) {
      style += ` stroke-dasharray="${dashArray}"`;
    }
    style += ' stroke-linecap="round" stroke-linejoin="round"';

    return style;
  }

  /**
   * Get CSS class name for a line based on its properties
   */
  getCSSClass(line: ArchitecturalLine): string {
    const classes: string[] = [
      `line-${line.category}`,
      `weight-${line.lineWeight}`,
      `style-${line.lineStyle}`,
    ];

    if (line.visibility === 'hidden') {
      classes.push('hidden-line');
    }

    return classes.join(' ');
  }

  /**
   * Generate CSS rules for all line styles
   */
  generateCSSRules(scale: number = 1): string {
    const rules: string[] = [];

    // Weight-based widths
    rules.push(`.weight-heavy { stroke-width: ${0.5 * scale}mm; }`);
    rules.push(`.weight-medium { stroke-width: ${0.35 * scale}mm; }`);
    rules.push(`.weight-light { stroke-width: ${0.25 * scale}mm; }`);
    rules.push(`.weight-hairline { stroke-width: ${0.18 * scale}mm; }`);

    // Style-based patterns
    rules.push(`.style-solid { stroke-dasharray: none; }`);
    rules.push(`.style-dashed { stroke-dasharray: 4 2; }`);
    rules.push(`.style-dotted { stroke-dasharray: 1 2; }`);
    rules.push(`.style-centerline { stroke-dasharray: 10 3 2 3; }`);
    rules.push(`.style-phantom { stroke-dasharray: 8 3 2 3 2 3; }`);

    // Category colors (optional, usually all black)
    rules.push(`.line-cut { stroke: #000000; }`);
    rules.push(`.line-projection { stroke: #333333; }`);
    rules.push(`.line-hidden { stroke: #666666; }`);
    rules.push(`.line-annotation { stroke: #000000; }`);

    return rules.join('\n');
  }
}

/**
 * Create a default line styler
 */
export function createLineStyler(): LineStyler {
  return new LineStyler();
}

/**
 * Apply hidden line style (for lines marked as hidden)
 */
export function applyHiddenStyle(line: ArchitecturalLine): ArchitecturalLine {
  return {
    ...line,
    lineStyle: 'dashed',
    lineWeight: 'hairline',
    semanticType: 'hidden',
  };
}
