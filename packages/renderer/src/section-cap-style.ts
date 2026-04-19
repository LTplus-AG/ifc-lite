/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section cap styling — shared between the renderer and its consumers.
 *
 * The 3D cut surface is rendered by `Section2DOverlayRenderer` using the exact
 * polygons `SectionCutter` produces from triangle-plane intersection. This
 * module carries only the styling primitives that flow through it:
 *   - `HATCH_PATTERN_IDS`: name → numeric id, kept in lockstep with the
 *     `patternId` switch in the 2D-overlay fill fragment shader.
 *   - `SectionCapStyle` / `DEFAULT_CAP_STYLE`: the shape + defaults the store
 *     persists to localStorage and the renderer consumes per-frame.
 *
 * Kept as a separate file (rather than folded into `types.ts`) so the hatch
 * id mapping has a single source of truth that both shader authors and UI
 * authors can grep for.
 */

export const HATCH_PATTERN_IDS = {
  solid:       0,
  diagonal:    1,
  crossHatch:  2,
  horizontal:  3,
  vertical:    4,
  concrete:    5,
  brick:       6,
  insulation:  7,
} as const;

export type HatchPatternId = keyof typeof HATCH_PATTERN_IDS;

export interface SectionCapStyle {
  fillColor:         [number, number, number, number];
  strokeColor:       [number, number, number, number];
  pattern:           HatchPatternId;
  spacingPx:         number;
  angleRad:          number;
  widthPx:           number;
  secondaryAngleRad: number;
}

export const DEFAULT_CAP_STYLE: SectionCapStyle = {
  fillColor:         [0.92, 0.88, 0.78, 1.0],  // warm paper
  strokeColor:       [0.10, 0.10, 0.10, 1.0],  // ink
  pattern:           'diagonal',
  spacingPx:         8,
  angleRad:          Math.PI / 4,              // 45°
  widthPx:           1.0,
  secondaryAngleRad: -Math.PI / 4,
};
