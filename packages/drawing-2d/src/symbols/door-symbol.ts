/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Door symbol generator for architectural floor plans
 *
 * Generates standard door symbols including:
 * - Swing arc (quarter circle showing door travel)
 * - Door leaf line (panel in closed position)
 * - Support for single/double swing, sliding, folding doors
 */

import type {
  ArchitecturalSymbol,
  DoorSwingParameters,
  SlidingDoorParameters,
  OpeningInfo,
  Point2D,
  Line2D,
  DoorOperationType,
  Bounds2D,
} from '../types.js';

/**
 * Result of door symbol generation
 */
export interface DoorSymbolResult {
  /** The architectural symbol */
  symbol: ArchitecturalSymbol;
  /** Lines to draw (arc segments, leaf lines) */
  lines: Line2D[];
  /** Arc path for SVG (if applicable) */
  arcPath?: string;
}

/**
 * Configuration for door symbol generation
 */
export interface DoorSymbolConfig {
  /** Number of segments for arc approximation */
  arcSegments: number;
  /** Swing angle in degrees (default 90) */
  swingAngle: number;
  /** Show door leaf line */
  showLeaf: boolean;
  /** Show threshold line */
  showThreshold: boolean;
}

const DEFAULT_CONFIG: DoorSymbolConfig = {
  arcSegments: 16,
  swingAngle: 90,
  showLeaf: true,
  showThreshold: false,
};

/**
 * Generates door symbols for 2D floor plans
 */
export class DoorSymbolGenerator {
  private config: DoorSymbolConfig;

  constructor(config: Partial<DoorSymbolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate door symbol from opening info
   */
  generateFromOpening(
    opening: OpeningInfo,
    bounds2D: Bounds2D,
    wallDirection: Point2D
  ): DoorSymbolResult {
    const operation = opening.doorOperation ?? 'SINGLE_SWING_LEFT';
    const width = opening.width;

    // Calculate center of opening
    const center: Point2D = {
      x: (bounds2D.min.x + bounds2D.max.x) / 2,
      y: (bounds2D.min.y + bounds2D.max.y) / 2,
    };

    // Determine wall perpendicular direction (into room)
    const perpendicular = this.getPerpendicularDirection(wallDirection);

    return this.generateSymbol(center, width, operation, wallDirection, perpendicular);
  }

  /**
   * Generate a door symbol at a specific position
   */
  generateSymbol(
    center: Point2D,
    width: number,
    operation: DoorOperationType,
    wallDirection: Point2D,
    swingDirection: Point2D
  ): DoorSymbolResult {
    switch (operation) {
      case 'SINGLE_SWING_LEFT':
        return this.generateSwingDoor(center, width, wallDirection, swingDirection, 'left', false);
      case 'SINGLE_SWING_RIGHT':
        return this.generateSwingDoor(center, width, wallDirection, swingDirection, 'right', false);
      case 'DOUBLE_SWING_LEFT':
        return this.generateSwingDoor(center, width, wallDirection, swingDirection, 'left', true);
      case 'DOUBLE_SWING_RIGHT':
        return this.generateSwingDoor(center, width, wallDirection, swingDirection, 'right', true);
      case 'DOUBLE_DOOR_SINGLE_SWING':
      case 'DOUBLE_DOOR_DOUBLE_SWING':
        return this.generateDoubleDoor(center, width, wallDirection, swingDirection);
      case 'SLIDING_TO_LEFT':
        return this.generateSlidingDoor(center, width, wallDirection, 'left');
      case 'SLIDING_TO_RIGHT':
        return this.generateSlidingDoor(center, width, wallDirection, 'right');
      case 'DOUBLE_DOOR_SLIDING':
        return this.generateDoubleSlidingDoor(center, width, wallDirection);
      case 'FOLDING_TO_LEFT':
        return this.generateFoldingDoor(center, width, wallDirection, 'left');
      case 'FOLDING_TO_RIGHT':
        return this.generateFoldingDoor(center, width, wallDirection, 'right');
      case 'REVOLVING':
        return this.generateRevolvingDoor(center, width);
      default:
        // Default to single swing left
        return this.generateSwingDoor(center, width, wallDirection, swingDirection, 'left', false);
    }
  }

  /**
   * Generate single swing door symbol
   */
  private generateSwingDoor(
    center: Point2D,
    width: number,
    wallDir: Point2D,
    swingDir: Point2D,
    hingeSide: 'left' | 'right',
    bothWays: boolean
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const halfWidth = width / 2;

    // Calculate hinge point (at edge of opening)
    const hingeOffset = hingeSide === 'left' ? -halfWidth : halfWidth;
    const hingePoint: Point2D = {
      x: center.x + wallDir.x * hingeOffset,
      y: center.y + wallDir.y * hingeOffset,
    };

    // Door leaf endpoint (open position)
    const swingAngleRad = (this.config.swingAngle * Math.PI) / 180;
    const leafEnd: Point2D = {
      x: hingePoint.x + swingDir.x * width,
      y: hingePoint.y + swingDir.y * width,
    };

    // Door leaf line (shows door in open position)
    if (this.config.showLeaf) {
      lines.push({ start: hingePoint, end: leafEnd });
    }

    // Generate swing arc
    const arcLines = this.generateArc(
      hingePoint,
      width,
      wallDir,
      swingDir,
      hingeSide === 'left' ? 1 : -1,
      swingAngleRad
    );
    lines.push(...arcLines);

    // If door swings both ways, add arc on opposite side
    if (bothWays) {
      const oppositeSwingDir: Point2D = {
        x: -swingDir.x,
        y: -swingDir.y,
      };
      const oppositeArcLines = this.generateArc(
        hingePoint,
        width,
        wallDir,
        oppositeSwingDir,
        hingeSide === 'left' ? -1 : 1,
        swingAngleRad
      );
      lines.push(...oppositeArcLines);
    }

    const params: DoorSwingParameters = {
      width,
      swingDirection: hingeSide === 'left' ? 1 : -1,
      swingAngle: swingAngleRad,
      hingePoint,
      isDouble: false,
    };

    return {
      symbol: {
        type: 'door-swing',
        position: center,
        rotation: Math.atan2(wallDir.y, wallDir.x),
        scale: 1,
        parameters: params,
      },
      lines,
      arcPath: this.generateArcSVGPath(hingePoint, width, wallDir, swingDir, swingAngleRad),
    };
  }

  /**
   * Generate double door symbol (two leaves meeting in middle)
   */
  private generateDoubleDoor(
    center: Point2D,
    width: number,
    wallDir: Point2D,
    swingDir: Point2D
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const halfWidth = width / 2;
    const leafWidth = halfWidth;

    // Left hinge point
    const leftHinge: Point2D = {
      x: center.x - wallDir.x * halfWidth,
      y: center.y - wallDir.y * halfWidth,
    };

    // Right hinge point
    const rightHinge: Point2D = {
      x: center.x + wallDir.x * halfWidth,
      y: center.y + wallDir.y * halfWidth,
    };

    const swingAngleRad = (this.config.swingAngle * Math.PI) / 180;

    // Left door leaf and arc
    if (this.config.showLeaf) {
      lines.push({
        start: leftHinge,
        end: {
          x: leftHinge.x + swingDir.x * leafWidth,
          y: leftHinge.y + swingDir.y * leafWidth,
        },
      });
    }
    lines.push(...this.generateArc(leftHinge, leafWidth, wallDir, swingDir, 1, swingAngleRad));

    // Right door leaf and arc
    if (this.config.showLeaf) {
      lines.push({
        start: rightHinge,
        end: {
          x: rightHinge.x + swingDir.x * leafWidth,
          y: rightHinge.y + swingDir.y * leafWidth,
        },
      });
    }
    lines.push(...this.generateArc(rightHinge, leafWidth, wallDir, swingDir, -1, swingAngleRad));

    const params: DoorSwingParameters = {
      width,
      swingDirection: 1,
      swingAngle: swingAngleRad,
      hingePoint: center,
      isDouble: true,
    };

    return {
      symbol: {
        type: 'door-swing',
        position: center,
        rotation: Math.atan2(wallDir.y, wallDir.x),
        scale: 1,
        parameters: params,
      },
      lines,
    };
  }

  /**
   * Generate sliding door symbol
   */
  private generateSlidingDoor(
    center: Point2D,
    width: number,
    wallDir: Point2D,
    slideDirection: 'left' | 'right'
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const halfWidth = width / 2;

    // Door panel line (centered)
    const panelStart: Point2D = {
      x: center.x - wallDir.x * halfWidth,
      y: center.y - wallDir.y * halfWidth,
    };
    const panelEnd: Point2D = {
      x: center.x + wallDir.x * halfWidth,
      y: center.y + wallDir.y * halfWidth,
    };
    lines.push({ start: panelStart, end: panelEnd });

    // Arrow indicating slide direction
    const arrowDir = slideDirection === 'left' ? -1 : 1;
    const arrowLen = width * 0.3;
    const arrowStart: Point2D = {
      x: center.x - wallDir.x * arrowLen * 0.5 * arrowDir,
      y: center.y - wallDir.y * arrowLen * 0.5 * arrowDir,
    };
    const arrowEnd: Point2D = {
      x: center.x + wallDir.x * arrowLen * 0.5 * arrowDir,
      y: center.y + wallDir.y * arrowLen * 0.5 * arrowDir,
    };
    lines.push({ start: arrowStart, end: arrowEnd });

    const params: SlidingDoorParameters = {
      width,
      slideDirection: arrowDir as 1 | -1,
      panelCount: 1,
    };

    return {
      symbol: {
        type: 'door-sliding',
        position: center,
        rotation: Math.atan2(wallDir.y, wallDir.x),
        scale: 1,
        parameters: params,
      },
      lines,
    };
  }

  /**
   * Generate double sliding door symbol
   */
  private generateDoubleSlidingDoor(
    center: Point2D,
    width: number,
    wallDir: Point2D
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const quarterWidth = width / 4;

    // Two panel lines that slide apart
    const leftPanel: Line2D = {
      start: {
        x: center.x - wallDir.x * quarterWidth * 2,
        y: center.y - wallDir.y * quarterWidth * 2,
      },
      end: center,
    };
    const rightPanel: Line2D = {
      start: center,
      end: {
        x: center.x + wallDir.x * quarterWidth * 2,
        y: center.y + wallDir.y * quarterWidth * 2,
      },
    };
    lines.push(leftPanel, rightPanel);

    const params: SlidingDoorParameters = {
      width,
      slideDirection: 1,
      panelCount: 2,
    };

    return {
      symbol: {
        type: 'door-sliding',
        position: center,
        rotation: Math.atan2(wallDir.y, wallDir.x),
        scale: 1,
        parameters: params,
      },
      lines,
    };
  }

  /**
   * Generate folding door symbol
   */
  private generateFoldingDoor(
    center: Point2D,
    width: number,
    wallDir: Point2D,
    foldDirection: 'left' | 'right'
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const halfWidth = width / 2;

    // Accordion-style zigzag pattern
    const hingePoint: Point2D = {
      x: center.x + wallDir.x * halfWidth * (foldDirection === 'left' ? -1 : 1),
      y: center.y + wallDir.y * halfWidth * (foldDirection === 'left' ? -1 : 1),
    };

    // Draw folded panels as small zigzag
    const panelCount = 3;
    const panelWidth = width / panelCount;
    const foldDepth = panelWidth * 0.3;
    const perpDir = this.getPerpendicularDirection(wallDir);

    let currentX = hingePoint.x;
    let currentY = hingePoint.y;

    for (let i = 0; i < panelCount; i++) {
      const offset = i % 2 === 0 ? foldDepth : -foldDepth;
      const nextX = currentX + wallDir.x * panelWidth * (foldDirection === 'left' ? 1 : -1);
      const nextY = currentY + wallDir.y * panelWidth * (foldDirection === 'left' ? 1 : -1);

      lines.push({
        start: { x: currentX, y: currentY },
        end: {
          x: nextX + perpDir.x * offset,
          y: nextY + perpDir.y * offset,
        },
      });

      currentX = nextX;
      currentY = nextY;
    }

    return {
      symbol: {
        type: 'door-folding',
        position: center,
        rotation: Math.atan2(wallDir.y, wallDir.x),
        scale: 1,
        parameters: { width, slideDirection: foldDirection === 'left' ? -1 : 1, panelCount },
      },
      lines,
    };
  }

  /**
   * Generate revolving door symbol
   */
  private generateRevolvingDoor(
    center: Point2D,
    width: number
  ): DoorSymbolResult {
    const lines: Line2D[] = [];
    const radius = width / 2;

    // Draw circle (as line segments)
    const circleSegments = 24;
    for (let i = 0; i < circleSegments; i++) {
      const angle1 = (i / circleSegments) * Math.PI * 2;
      const angle2 = ((i + 1) / circleSegments) * Math.PI * 2;
      lines.push({
        start: {
          x: center.x + Math.cos(angle1) * radius,
          y: center.y + Math.sin(angle1) * radius,
        },
        end: {
          x: center.x + Math.cos(angle2) * radius,
          y: center.y + Math.sin(angle2) * radius,
        },
      });
    }

    // Draw 4 door leaves (cross pattern)
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      lines.push({
        start: center,
        end: {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        },
      });
    }

    return {
      symbol: {
        type: 'door-revolving',
        position: center,
        rotation: 0,
        scale: 1,
        parameters: { width, swingDirection: 1, swingAngle: Math.PI / 2, hingePoint: center, isDouble: false },
      },
      lines,
    };
  }

  /**
   * Generate arc as line segments
   */
  private generateArc(
    center: Point2D,
    radius: number,
    wallDir: Point2D,
    swingDir: Point2D,
    direction: 1 | -1,
    angleRad: number
  ): Line2D[] {
    const lines: Line2D[] = [];
    const segments = this.config.arcSegments;

    // Start angle is along wall direction (door closed)
    const startAngle = Math.atan2(wallDir.y, wallDir.x) + (direction > 0 ? Math.PI : 0);

    for (let i = 0; i < segments; i++) {
      const t1 = i / segments;
      const t2 = (i + 1) / segments;
      const angle1 = startAngle + direction * t1 * angleRad;
      const angle2 = startAngle + direction * t2 * angleRad;

      lines.push({
        start: {
          x: center.x + Math.cos(angle1) * radius,
          y: center.y + Math.sin(angle1) * radius,
        },
        end: {
          x: center.x + Math.cos(angle2) * radius,
          y: center.y + Math.sin(angle2) * radius,
        },
      });
    }

    return lines;
  }

  /**
   * Generate SVG arc path string
   */
  private generateArcSVGPath(
    center: Point2D,
    radius: number,
    wallDir: Point2D,
    swingDir: Point2D,
    angleRad: number
  ): string {
    const startAngle = Math.atan2(wallDir.y, wallDir.x);
    const endAngle = startAngle + angleRad;

    const startX = center.x + Math.cos(startAngle) * radius;
    const startY = center.y + Math.sin(startAngle) * radius;
    const endX = center.x + Math.cos(endAngle) * radius;
    const endY = center.y + Math.sin(endAngle) * radius;

    const largeArc = angleRad > Math.PI ? 1 : 0;
    const sweep = 1;

    return `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${endX} ${endY}`;
  }

  private getPerpendicularDirection(dir: Point2D): Point2D {
    return { x: -dir.y, y: dir.x };
  }
}
