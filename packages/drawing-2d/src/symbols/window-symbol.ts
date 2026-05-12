/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Window symbol generator for architectural floor plans
 *
 * Generates standard window symbols including:
 * - Frame lines (parallel lines at opening edges)
 * - Glass line (single line in center)
 * - Mullions (for multi-pane windows)
 */

import type {
  ArchitecturalSymbol,
  WindowFrameParameters,
  OpeningInfo,
  Point2D,
  Line2D,
  WindowPartitioningType,
  Bounds2D,
} from '../types.js';

/**
 * Result of window symbol generation
 */
export interface WindowSymbolResult {
  /** The architectural symbol */
  symbol: ArchitecturalSymbol;
  /** Lines to draw (frame, glass, mullions) */
  lines: Line2D[];
}

/**
 * Configuration for window symbol generation
 */
export interface WindowSymbolConfig {
  /** Frame depth as fraction of wall thickness (default 0.1) */
  frameDepthRatio: number;
  /** Show glass line in center */
  showGlassLine: boolean;
  /** Show frame lines */
  showFrameLines: boolean;
  /** Wall thickness for frame offset calculation */
  defaultWallThickness: number;
}

const DEFAULT_CONFIG: WindowSymbolConfig = {
  frameDepthRatio: 0.1,
  showGlassLine: true,
  showFrameLines: true,
  defaultWallThickness: 0.2, // 200mm
};

/**
 * Generates window symbols for 2D floor plans
 */
export class WindowSymbolGenerator {
  private config: WindowSymbolConfig;

  constructor(config: Partial<WindowSymbolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate window symbol from opening info
   */
  generateFromOpening(
    opening: OpeningInfo,
    bounds2D: Bounds2D,
    wallDirection: Point2D,
    wallThickness?: number
  ): WindowSymbolResult {
    const partitioning = opening.windowPartitioning ?? 'SINGLE_PANEL';
    const width = opening.width;
    const thickness = wallThickness ?? this.config.defaultWallThickness;

    // Calculate center of opening
    const center: Point2D = {
      x: (bounds2D.min.x + bounds2D.max.x) / 2,
      y: (bounds2D.min.y + bounds2D.max.y) / 2,
    };

    // Determine perpendicular direction
    const perpendicular = this.getPerpendicularDirection(wallDirection);

    return this.generateSymbol(center, width, thickness, wallDirection, perpendicular, partitioning);
  }

  /**
   * Generate a window symbol at a specific position
   */
  generateSymbol(
    center: Point2D,
    width: number,
    wallThickness: number,
    wallDirection: Point2D,
    perpDirection: Point2D,
    partitioning: WindowPartitioningType
  ): WindowSymbolResult {
    const lines: Line2D[] = [];
    const halfWidth = width / 2;
    const frameDepth = wallThickness * this.config.frameDepthRatio;
    const halfThickness = wallThickness / 2;

    // Frame lines (two parallel lines at opening edges along wall direction)
    if (this.config.showFrameLines) {
      // Outer frame line (at wall face)
      lines.push({
        start: {
          x: center.x - wallDirection.x * halfWidth + perpDirection.x * halfThickness,
          y: center.y - wallDirection.y * halfWidth + perpDirection.y * halfThickness,
        },
        end: {
          x: center.x + wallDirection.x * halfWidth + perpDirection.x * halfThickness,
          y: center.y + wallDirection.y * halfWidth + perpDirection.y * halfThickness,
        },
      });

      // Inner frame line (at opposite wall face)
      lines.push({
        start: {
          x: center.x - wallDirection.x * halfWidth - perpDirection.x * halfThickness,
          y: center.y - wallDirection.y * halfWidth - perpDirection.y * halfThickness,
        },
        end: {
          x: center.x + wallDirection.x * halfWidth - perpDirection.x * halfThickness,
          y: center.y + wallDirection.y * halfWidth - perpDirection.y * halfThickness,
        },
      });

      // Jamb lines (short lines at window edges)
      lines.push({
        start: {
          x: center.x - wallDirection.x * halfWidth + perpDirection.x * halfThickness,
          y: center.y - wallDirection.y * halfWidth + perpDirection.y * halfThickness,
        },
        end: {
          x: center.x - wallDirection.x * halfWidth - perpDirection.x * halfThickness,
          y: center.y - wallDirection.y * halfWidth - perpDirection.y * halfThickness,
        },
      });

      lines.push({
        start: {
          x: center.x + wallDirection.x * halfWidth + perpDirection.x * halfThickness,
          y: center.y + wallDirection.y * halfWidth + perpDirection.y * halfThickness,
        },
        end: {
          x: center.x + wallDirection.x * halfWidth - perpDirection.x * halfThickness,
          y: center.y + wallDirection.y * halfWidth - perpDirection.y * halfThickness,
        },
      });
    }

    // Glass line (single line in center of wall)
    if (this.config.showGlassLine) {
      lines.push({
        start: {
          x: center.x - wallDirection.x * halfWidth,
          y: center.y - wallDirection.y * halfWidth,
        },
        end: {
          x: center.x + wallDirection.x * halfWidth,
          y: center.y + wallDirection.y * halfWidth,
        },
      });
    }

    // Add mullions based on partitioning type
    const mullionLines = this.generateMullions(center, width, wallThickness, wallDirection, perpDirection, partitioning);
    lines.push(...mullionLines);

    const params: WindowFrameParameters = {
      width,
      frameDepth,
      mullionCount: this.getMullionCount(partitioning),
    };

    return {
      symbol: {
        type: 'window-frame',
        position: center,
        rotation: Math.atan2(wallDirection.y, wallDirection.x),
        scale: 1,
        parameters: params,
      },
      lines,
    };
  }

  /**
   * Generate mullion lines based on window partitioning
   */
  private generateMullions(
    center: Point2D,
    width: number,
    wallThickness: number,
    wallDirection: Point2D,
    perpDirection: Point2D,
    partitioning: WindowPartitioningType
  ): Line2D[] {
    const lines: Line2D[] = [];
    const halfThickness = wallThickness / 2;

    switch (partitioning) {
      case 'DOUBLE_PANEL_VERTICAL':
        // Single vertical mullion in center
        lines.push({
          start: {
            x: center.x + perpDirection.x * halfThickness,
            y: center.y + perpDirection.y * halfThickness,
          },
          end: {
            x: center.x - perpDirection.x * halfThickness,
            y: center.y - perpDirection.y * halfThickness,
          },
        });
        break;

      case 'DOUBLE_PANEL_HORIZONTAL':
        // Single horizontal mullion in center (along wall direction)
        // This would be a line perpendicular to the wall
        break;

      case 'TRIPLE_PANEL_VERTICAL':
        // Two vertical mullions
        const thirdWidth = width / 3;
        for (const offset of [-thirdWidth / 2, thirdWidth / 2]) {
          lines.push({
            start: {
              x: center.x + wallDirection.x * offset + perpDirection.x * halfThickness,
              y: center.y + wallDirection.y * offset + perpDirection.y * halfThickness,
            },
            end: {
              x: center.x + wallDirection.x * offset - perpDirection.x * halfThickness,
              y: center.y + wallDirection.y * offset - perpDirection.y * halfThickness,
            },
          });
        }
        break;

      case 'TRIPLE_PANEL_BOTTOM':
      case 'TRIPLE_PANEL_TOP':
        // One horizontal mullion and one vertical in lower/upper section
        lines.push({
          start: {
            x: center.x + perpDirection.x * halfThickness,
            y: center.y + perpDirection.y * halfThickness,
          },
          end: {
            x: center.x - perpDirection.x * halfThickness,
            y: center.y - perpDirection.y * halfThickness,
          },
        });
        break;

      default:
        // SINGLE_PANEL and others - no mullions
        break;
    }

    return lines;
  }

  private getMullionCount(partitioning: WindowPartitioningType): number {
    switch (partitioning) {
      case 'DOUBLE_PANEL_VERTICAL':
      case 'DOUBLE_PANEL_HORIZONTAL':
        return 1;
      case 'TRIPLE_PANEL_VERTICAL':
      case 'TRIPLE_PANEL_HORIZONTAL':
      case 'TRIPLE_PANEL_BOTTOM':
      case 'TRIPLE_PANEL_TOP':
      case 'TRIPLE_PANEL_LEFT':
      case 'TRIPLE_PANEL_RIGHT':
        return 2;
      default:
        return 0;
    }
  }

  private getPerpendicularDirection(dir: Point2D): Point2D {
    return { x: -dir.y, y: dir.x };
  }
}

/**
 * Generate simple window lines (frame only, no symbol object)
 */
export function generateSimpleWindowLines(
  center: Point2D,
  width: number,
  wallDirection: Point2D,
  wallThickness: number = 0.2
): Line2D[] {
  const generator = new WindowSymbolGenerator();
  const perpDirection = { x: -wallDirection.y, y: wallDirection.x };
  const result = generator.generateSymbol(
    center,
    width,
    wallThickness,
    wallDirection,
    perpDirection,
    'SINGLE_PANEL'
  );
  return result.lines;
}
