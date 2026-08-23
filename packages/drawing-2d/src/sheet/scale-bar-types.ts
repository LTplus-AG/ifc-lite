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
 * Round distances a scale bar is allowed to span, ascending.
 *
 * Shared by the two things that pick a bar length — the sheet's default
 * ("what should this bar be?") and the title-block renderer's snap ("largest
 * one that fits this cell") — so they cannot disagree about what "nice" means.
 * They were separate literals with identical contents, which is one edit away
 * from divergence.
 *
 * Every entry survives the printed label's formatting exactly: whole
 * centimetres below 1 m, whole metres above. That is the property that makes
 * the snap able to promise an exact label, so a new entry has to keep it —
 * 0.15 would print "15cm" correctly but 0.125 would print "13cm" and lie.
 *
 * Reaches 0.02 because `maxBarWidth` is `min(width * 0.3, 50)`. On the shipped
 * compact preset (120 mm) that is 36 mm, and stopping the ladder at 0.1 left
 * both 1:1 and 1:2 with no bar at all. At the full 50 mm only 1:1 fails, since
 * 0.1 m at 1:2 is exactly 50 mm — so 36 is the binding number, which is what
 * `scale-bar-ladder.test.ts` asserts against.
 */
export const NICE_BAR_LENGTHS_M: readonly number[] = [
  0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
];

/**
 * Whether `m` survives the scale bar's label formatting without lying:
 * whole centimetres below 1 m, whole metres above.
 */
export function barLabelIsExact(m: number): boolean {
  // States the contract explicitly. The arithmetic below happens to reject all
  // of these too — -5 fails the `>= 1` floor, NaN and Infinity fail because
  // `Math.abs(NaN - NaN)` is not `< 1e-9` — so removing this line changes no
  // test. It is kept as documentation a reader does not have to derive, not as
  // a load-bearing check.
  if (!(m > 0) || !Number.isFinite(m)) return false;
  // Symmetric epsilon on both branches. `Number.isInteger` alone is too strict
  // for the float artefacts the ladder itself carries (`0.02 * 100` is
  // 2.0000000000000004), and `Math.round(m * 1000) / 10` was too loose in the
  // other direction: it tolerates ±0.5 mm, so 0.0201 m passed and printed
  // "2cm" over a bar 0.1 mm longer than that.
  //
  // The `>= 1` is what stops a sub-centimetre length passing. Without it,
  // anything under 0.005 m rounds to zero centimetres, which is an integer, so
  // it was "exact" — and drew a 0.4 mm bar labelled "0cm". A bar claiming to
  // span no distance is less honest than no bar.
  if (m < 1) {
    const cm = m * 100;
    return Math.abs(cm - Math.round(cm)) < 1e-9 && Math.round(cm) >= 1;
  }
  return Math.abs(m - Math.round(m)) < 1e-9;
}

/**
 * Smallest SEGMENT worth drawing, in millimetres of paper.
 *
 * Segment widths are emitted through `toFixed(2)`, so anything under 0.005 mm
 * prints `width="0.00"` — a label with no bar under it. That is reachable: at
 * 1:1 on a 760 m model the transform gives 0.42 mm per metre, so a 5 cm bar is
 * 0.02 mm wide and all five of its segments print zero. The old clamp-to-cell
 * hid this by always stretching the bar to fill the cell; choosing the distance
 * first removed that accident, so the floor has to be explicit.
 *
 * Deliberately a per-SEGMENT bound rather than a whole-bar one. A blanket bar
 * minimum of 5 mm rejects a perfectly legible 4 mm bar at 1:500, which is a
 * real configuration; what actually fails is a segment rounding to zero, and
 * that is what this measures. 0.01 mm is twice the rounding threshold.
 *
 * A correction to an earlier version of this note, because it misattributed
 * the mechanism: the old `Math.min(barLengthMm, maxBarWidth)` clamp could not
 * ENLARGE anything. What filled the cell was the reciprocal-units bug — at
 * 0.42 mm per metre the old formula computed `0.05 * 1000 / 0.42` = 119 mm and
 * the clamp capped that at 50. So one bug was hiding another, which is why
 * fixing the arithmetic is what exposed this.
 */
export const MIN_BAR_SEGMENT_MM = 0.01;

/** The end label the scale bar prints for a given distance. */
export function formatBarLabel(m: number): string {
  return m < 1 ? `${(m * 100).toFixed(0)}cm` : `${m.toFixed(0)}m`;
}

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

  for (const n of NICE_BAR_LENGTHS_M) {
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
