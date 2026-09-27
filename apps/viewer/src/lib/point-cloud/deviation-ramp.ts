/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BIM↔scan deviation heatmap's diverging colour ramp (#5507).
 *
 * Three fixed stops on a blue → white → red diverging scale: far-negative
 * (scan inside the surface), on-surface, far-positive (scan outside the
 * surface). This is DATA describing what the ramp looks like, not viewport
 * UI chrome — it does not belong in `overlay-theme.ts`'s accent/surface
 * token set, the same way `PointCloudClasses.tsx`'s `CLASS_COLORS` map
 * (the ASPRS classification palette) stays out of it too.
 *
 * Mirrors `deviation_ramp()` in `point-shader.wgsl.ts` (normalised 0..1
 * floats there vs. 0..255 `rgb()` here for the CSS legend) — keep the two
 * in sync if either changes:
 *   cool end   0.10, 0.30, 0.85  ==  rgb(26,77,217)
 *   warm end   0.85, 0.20, 0.10  ==  rgb(217,51,26)
 */
export const DEVIATION_RAMP_STOPS = [
  'rgb(26,77,217)', // far negative — scan inside the BIM surface
  'rgb(242,242,242)', // on surface
  'rgb(217,51,26)', // far positive — scan outside the BIM surface
] as const;

/** Ready-to-use CSS `background` value for the legend swatch. */
export const DEVIATION_RAMP_CSS_GRADIENT = `linear-gradient(to right, ${DEVIATION_RAMP_STOPS.join(', ')})`;
