/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale Bar Types
 *
 * Configuration for the scale bar drawn in the sheet's title block
 * (`renderScaleBarInTitleBlock` in `title-block-renderer.ts`, and its
 * on-screen twin in the viewer's `Drawing2DCanvas`). Both draw one
 * alternating-segment metric bar with `0` and end-distance labels; every
 * field below is one that those renderers actually read.
 */

/** Scale bar configuration */
export interface ScaleBarConfig {
  /** Whether to show scale bar */
  visible: boolean;
  /** Total length in model units (meters) */
  totalLengthM: number;
  /** Number of primary divisions */
  primaryDivisions: number;
  /** Bar height in mm (clamped to 3mm by the renderer) */
  heightMm: number;
  /** Fill color for filled segments */
  fillColor: string;
  /** Stroke color */
  strokeColor: string;
  /** Line weight */
  lineWeight: number;
}

/** Default scale bar configuration */
export const DEFAULT_SCALE_BAR: ScaleBarConfig = {
  visible: true,
  totalLengthM: 5, // Will be auto-calculated based on scale
  primaryDivisions: 5,
  heightMm: 3,
  fillColor: '#000000',
  strokeColor: '#000000',
  lineWeight: 0.25,
};

/**
 * Calculate optimal scale bar length based on drawing scale
 * Returns length in model units (meters)
 *
 * @param scaleFactor - Drawing scale factor (e.g., 100 for 1:100)
 * @param maxLengthMm - Maximum length on paper in mm
 */
export function calculateOptimalScaleBarLength(
  scaleFactor: number,
  maxLengthMm: number
): number {
  // Target ~60-80mm on paper for readability
  const targetPaperLengthMm = Math.min(80, maxLengthMm * 0.8);

  // Convert paper length to model units (meters)
  const modelLength = (targetPaperLengthMm * scaleFactor) / 1000;

  // Round to nice numbers for readability
  const niceNumbers = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
  ];

  for (const n of niceNumbers) {
    if (n >= modelLength * 0.5 && n <= modelLength * 1.5) {
      return n;
    }
  }

  // Fall back to rounded value
  return Math.round(modelLength);
}

/**
 * Calculate the number of divisions for a scale bar
 * Returns optimal division count for the given length
 */
export function calculateOptimalDivisions(totalLengthM: number): number {
  if (totalLengthM <= 1) return 5;
  if (totalLengthM <= 5) return 5;
  if (totalLengthM <= 10) return 5;
  if (totalLengthM <= 50) return 5;
  return 5; // Default to 5 divisions
}

/** North arrow style */
export type NorthArrowStyle = 'simple' | 'compass' | 'decorative' | 'none';

/**
 * North arrow configuration.
 *
 * The arrow is drawn at a fixed spot in the title block, so there is no
 * position field: `style` only selects between drawn ('simple', 'compass',
 * 'decorative' all render the same glyph today) and not drawn ('none').
 */
export interface NorthArrowConfig {
  /** Arrow style; 'none' suppresses the arrow */
  style: NorthArrowStyle;
  /** Rotation in degrees (0 = up) */
  rotation: number;
  /** Size in mm (clamped by the renderer to 8mm and to the title block) */
  sizeMm: number;
}

/** Default north arrow configuration */
export const DEFAULT_NORTH_ARROW: NorthArrowConfig = {
  style: 'simple',
  rotation: 0,
  sizeMm: 15,
};
