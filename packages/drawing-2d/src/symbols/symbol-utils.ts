/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Utility functions for architectural symbol generation
 */

import type {
  ArchitecturalSymbol,
  OpeningInfo,
  Point2D,
  Bounds2D,
  DoorOperationType,
  WindowPartitioningType,
} from '../types.js';
import { DoorSymbolGenerator, type DoorSymbolResult } from './door-symbol.js';
import { WindowSymbolGenerator, type WindowSymbolResult } from './window-symbol.js';

/**
 * Generate a door symbol from opening info
 */
export function generateDoorSymbol(
  opening: OpeningInfo,
  bounds2D: Bounds2D,
  wallDirection: Point2D
): DoorSymbolResult {
  const generator = new DoorSymbolGenerator();
  return generator.generateFromOpening(opening, bounds2D, wallDirection);
}

/**
 * Generate a door symbol at a specific position
 */
export function generateDoorSymbolAt(
  center: Point2D,
  width: number,
  operation: DoorOperationType,
  wallDirection: Point2D,
  swingDirection: Point2D
): DoorSymbolResult {
  const generator = new DoorSymbolGenerator();
  return generator.generateSymbol(center, width, operation, wallDirection, swingDirection);
}

/**
 * Generate a window symbol from opening info
 */
export function generateWindowSymbol(
  opening: OpeningInfo,
  bounds2D: Bounds2D,
  wallDirection: Point2D,
  wallThickness?: number
): WindowSymbolResult {
  const generator = new WindowSymbolGenerator();
  return generator.generateFromOpening(opening, bounds2D, wallDirection, wallThickness);
}

/**
 * Generate a window symbol at a specific position
 */
export function generateWindowSymbolAt(
  center: Point2D,
  width: number,
  wallDirection: Point2D,
  wallThickness: number,
  partitioning: WindowPartitioningType = 'SINGLE_PANEL'
): WindowSymbolResult {
  const generator = new WindowSymbolGenerator();
  const perpDirection = { x: -wallDirection.y, y: wallDirection.x };
  return generator.generateSymbol(center, width, wallThickness, wallDirection, perpDirection, partitioning);
}

/**
 * Generate a stair arrow symbol
 */
export function generateStairArrow(
  position: Point2D,
  direction: 'up' | 'down',
  length: number,
  rotation: number = 0,
  riserCount?: number
): ArchitecturalSymbol {
  return {
    type: 'stair-arrow',
    position,
    rotation,
    scale: 1,
    parameters: {
      direction,
      length,
      riserCount,
    },
  };
}

/**
 * Generate a north arrow symbol
 */
export function generateNorthArrow(
  position: Point2D,
  rotation: number = 0,
  scale: number = 1
): ArchitecturalSymbol {
  return {
    type: 'north-arrow',
    position,
    rotation,
    scale,
    parameters: {},
  };
}

/**
 * Generate a section mark symbol
 */
export function generateSectionMark(
  position: Point2D,
  sectionId: string,
  viewDirection: 'left' | 'right' | 'both',
  scale: number = 1
): ArchitecturalSymbol {
  return {
    type: 'section-mark',
    position,
    rotation: 0,
    scale,
    parameters: {
      sectionId,
      viewDirection,
    },
  };
}

/**
 * Generate a level mark symbol
 */
export function generateLevelMark(
  position: Point2D,
  elevation: number,
  label: string,
  scale: number = 1
): ArchitecturalSymbol {
  return {
    type: 'level-mark',
    position,
    rotation: 0,
    scale,
    parameters: {
      elevation,
      label,
    },
  };
}

/**
 * Determine wall direction from opening bounds
 * Returns normalized direction along the longer axis
 */
export function inferWallDirection(bounds2D: Bounds2D): Point2D {
  const width = bounds2D.max.x - bounds2D.min.x;
  const height = bounds2D.max.y - bounds2D.min.y;

  if (width > height) {
    return { x: 1, y: 0 };
  } else {
    return { x: 0, y: 1 };
  }
}

/**
 * Generate symbols for all openings
 */
export function generateOpeningSymbols(
  openings: OpeningInfo[],
  openingBounds2D: Map<number, Bounds2D>,
  wallDirections?: Map<number, Point2D>
): ArchitecturalSymbol[] {
  const symbols: ArchitecturalSymbol[] = [];

  for (const opening of openings) {
    const bounds = openingBounds2D.get(opening.openingId);
    if (!bounds) continue;

    const wallDir = wallDirections?.get(opening.hostElementId) ?? inferWallDirection(bounds);

    if (opening.type === 'door') {
      const result = generateDoorSymbol(opening, bounds, wallDir);
      symbols.push(result.symbol);
    } else if (opening.type === 'window') {
      const result = generateWindowSymbol(opening, bounds, wallDir);
      symbols.push(result.symbol);
    }
    // Pure openings (no door/window) don't get symbols
  }

  return symbols;
}
