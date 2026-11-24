/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Section cap hatch styling, re-exported from `types.ts` (kept apart for that module's size). */

export type SectionCapHatchId =
  | 'solid'
  | 'diagonal'
  | 'crossHatch'
  | 'horizontal'
  | 'vertical'
  | 'concrete'
  | 'brick'
  | 'insulation';

export interface SectionCapStyleOptions {
  /** Fill colour behind the hatch. RGBA 0-1. */
  fillColor?: [number, number, number, number];
  /** Hatch stroke colour. RGBA 0-1. */
  strokeColor?: [number, number, number, number];
  /** Hatch pattern id. */
  pattern?: SectionCapHatchId;
  /** Spacing between hatch lines, in screen pixels. */
  spacingPx?: number;
  /** Primary angle in radians. */
  angleRad?: number;
  /** Line width in pixels. */
  widthPx?: number;
  /** Secondary angle (cross-hatch). */
  secondaryAngleRad?: number;
}
