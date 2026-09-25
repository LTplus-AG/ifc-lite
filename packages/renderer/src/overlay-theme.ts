/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one colour vocabulary the renderer draws every overlay in (#5484,
 * charter #5478): the selection highlight, the section-plane preview, every
 * overlay line channel (section-cut outline, IfcAnnotation, alignment,
 * IfcGrid, DXF / LandXML), and the clash pair / overlap tints. Before this,
 * each of those was a colour hardcoded in the renderer (a WGSL constant, a
 * per-axis Material colour plus a stray violet, or a default that the app
 * never overrode), so none of them followed the app theme. `setOverlayTheme`
 * replaces all of it with one call the viewer makes on theme change.
 *
 * Two colour conventions meet at this boundary, and each field documents
 * which one it expects:
 *
 *   - `selection` feeds `main.wgsl.ts`'s lit pipeline, which re-lights the
 *     tint with scene lighting and ACES-tonemaps + gamma-encodes on output.
 *     Feeding it an sRGB-encoded value there double-encodes and washes out,
 *     so it wants TRUE LINEAR-LIGHT RGBA.
 *   - `sectionPlane`, `overlayLine`, `clashA`, `clashB` and `clashOverlap`
 *     feed unlit pipelines that write straight to the swapchain (the
 *     section-plane preview quad, the section-2D overlay line/box pipeline,
 *     and the plain material-colour override the clash highlight uses) —
 *     the same convention `setOverlayLineColor` and the historic per-axis
 *     hex literals used. They want sRGB-DIRECT RGBA: the same 0..1 numbers
 *     you would get dividing an `#rrggbb` byte by 255, no gamma decode.
 *
 * The viewer's bridge (`rendererOverlayTheme`) is the single place that knows
 * which of its `tokenToLinearRgba` / `tokenToRgba` helpers to call for each
 * field, so this boundary only has to be crossed once.
 */

/** `[r, g, b, a]` in 0..1. The colour-space convention is documented per field of {@link OverlayTheme}. */
export type Rgba = readonly [number, number, number, number];

export interface OverlayTheme {
  /**
   * Selection highlight tint. TRUE LINEAR-LIGHT RGBA — replaces the WGSL
   * constant `vec3<f32>(0.3, 0.6, 1.0)` that was hardcoded into the re-lit
   * selection branch of `main.wgsl.ts`.
   */
  selection: Rgba;
  /**
   * Section-plane preview accent — one tint for every axis and for
   * face-picked (custom) planes alike. sRGB-direct RGBA — replaces the
   * per-axis Material colours and the custom violet `#9C6BDE`.
   */
  sectionPlane: Rgba;
  /**
   * Colour for every overlay line channel (section-cut outline,
   * IfcAnnotation, alignment, IfcGrid, DXF / LandXML) — sRGB-direct RGBA.
   * Replaces `setOverlayLineColor`, whose default (opaque black) the app
   * never overrode.
   */
  overlayLine: Rgba;
  /**
   * Clash element A highlight tint. sRGB-direct RGBA. The pair is painted
   * through `Scene.setColorOverrides`, which bakes the colour into overlay
   * batches, so `setOverlayTheme` repaints every installed override EQUAL to
   * the previous theme's `clashA` in the new one (#5490). Paint the pair in
   * exactly this value and it follows the theme.
   */
  clashA: Rgba;
  /** Clash element B highlight tint. sRGB-direct RGBA. Follows the theme as `clashA` does. */
  clashB: Rgba;
  /**
   * Clash overlap box / contact-line / intersection-solid tint, used whenever
   * `setClashOverlapBox` / `setClashContactLines` / `setClashIntersectionSolid`
   * is called without a `color`. sRGB-direct RGBA.
   */
  clashOverlap: Rgba;
}

/**
 * Reproduces the renderer's pre-#5484 hardcoded look, so a caller that never
 * calls `setOverlayTheme` (a test, a standalone tool) sees no visual change:
 * the old selection blue, the old "down"-axis section-plane colour and
 * opaque-black overlay lines. The clash tints never had a renderer-side look
 * to preserve (every caller passed its own colour), so they are the viewer's
 * light-theme `clash-a` / `clash-b` / `clash-overlap` tokens (#5490) rather
 * than the retired amber / cyan / magenta.
 */
export const DEFAULT_OVERLAY_THEME: OverlayTheme = {
  // Linear-light decode of the historic sRGB selection-blue #4D99FF
  // (0.3, 0.6, 1.0): the shader used to srgbToLinear() that literal in place;
  // now it takes selectionColor as-is, so the default carries the decode.
  selection: [0.07323895587840543, 0.31854677812509186, 1, 1],
  sectionPlane: [0.012, 0.663, 0.957, 1], // #03A9F4 — the historic "down"-axis colour
  overlayLine: [0, 0, 0, 1],
  clashA: [0x8c / 255, 0x6c / 255, 0x3e / 255, 1], // #8c6c3e
  clashB: [0x00 / 255, 0x71 / 255, 0x97 / 255, 1], // #007197
  clashOverlap: [0xf5 / 255, 0x2a / 255, 0x65 / 255, 1], // #f52a65
};
