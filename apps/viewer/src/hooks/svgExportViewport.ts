/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The direct (non-sheet) SVG export's world-metres -> paper-mm arithmetic
 * (`useDrawingExport.ts`'s `generateExportSVG`). Pulled out per the PR #2119
 * follow-up: three sibling "world metres -> paper mm at scale N" transforms
 * (`dxfExportGeoref.ts`, the sheet export's `calculateDrawingTransform`, and
 * the PDF exporter) are already pinned by tests; this was the fourth,
 * unreachable because it lived inline in a hook with `useViewerStore`
 * dependencies.
 *
 * Unlike the other three, this transform does NOT map world points into
 * paper-mm space at all. `polygonToPath` etc. below emit path data directly
 * in (axis-flipped) WORLD units; the mm-per-world-unit scaling is entirely
 * delegated to the SVG element itself, via the ratio between its `width`/
 * `height` attributes (paper mm) and its `viewBox` (world units). A renderer
 * (browser, printer, `rsvg`) does the actual paper-mm placement when it lays
 * the `viewBox` out into the `width`x`height` box.
 *
 * `computeSvgExportViewport` is that arithmetic, extracted verbatim (no
 * behaviour change — see `svgExportViewport.test.ts`'s equivalence note).
 */

export interface SvgExportBounds {
  min: { x: number; y: number };
  max: { x: number; y: number };
}

export type SectionAxis = 'down' | 'front' | 'side';

export interface SvgExportViewport {
  /** `<svg width>`, paper mm. */
  widthMm: number;
  /** `<svg height>`, paper mm. */
  heightMm: number;
  /** `viewBox` min-x, world units (post axis-flip). */
  viewBoxMinX: number;
  /** `viewBox` min-y, world units (post axis-flip). */
  viewBoxMinY: number;
  /** `viewBox` width, world units (padded, flip-invariant). */
  viewBoxWidth: number;
  /** `viewBox` height, world units (padded, flip-invariant). */
  viewBoxHeight: number;
  /** Mirror X — true only for the 'side' axis. */
  flipX: boolean;
  /** Mirror Y — true for every axis except 'down' (plan). */
  flipY: boolean;
  /** `displayOptions.scale`, defaulted to 100 — the drawing scale (1:N). */
  effectiveScale: number;
}

/**
 * Compute the direct SVG export's paper dimensions, `viewBox`, and
 * axis-driven mirroring from the drawing bounds, the requested scale
 * (1:`scale`, e.g. 100), and the active section axis.
 *
 * Padding: 10% of `max(width, height)` of the UNPADDED drawing bounds,
 * in WORLD units (not mm) — deliberately not 10% of the paper size, so the
 * margin scales with the model rather than the sheet.
 *
 * Y-flip: 'down' (plan) doesn't flip, so north (world +Z, drawing +Y) reads
 * as up; 'front'/'side' flip Y so height (+Y) reads as up. X-flip: only
 * 'side', to view from the conventional direction. `viewBoxMinX`/`Y`
 * incorporate the flip so the flipped content (drawn by the caller with the
 * same flipX/flipY signs) still lands inside `[0, viewBoxWidth/Height]`.
 */
export function computeSvgExportViewport(
  bounds: SvgExportBounds,
  scale: number,
  axis: SectionAxis,
): SvgExportViewport {
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  // Padding around the drawing, in world units.
  const padding = Math.max(width, height) * 0.1;
  const viewMinX = bounds.min.x - padding;
  const viewMinY = bounds.min.y - padding;
  const viewBoxWidth = width + padding * 2;
  const viewBoxHeight = height + padding * 2;

  // SVG dimensions in mm (assuming model is in metres, scale 1:100 default).
  const effectiveScale = scale || 100;
  const widthMm = (viewBoxWidth * 1000) / effectiveScale;
  const heightMm = (viewBoxHeight * 1000) / effectiveScale;

  // Axis-specific flipping (matching canvas rendering):
  // - 'down' (plan view): DON'T flip Y so north (Z+) is up.
  // - 'front' and 'side': flip Y so height (Y+) is up.
  // - 'side': also flip X to look from the conventional direction.
  const flipY = axis !== 'down';
  const flipX = axis === 'side';

  const viewBoxMinX = flipX ? -viewMinX - viewBoxWidth : viewMinX;
  const viewBoxMinY = flipY ? -viewMinY - viewBoxHeight : viewMinY;

  return { widthMm, heightMm, viewBoxMinX, viewBoxMinY, viewBoxWidth, viewBoxHeight, flipX, flipY, effectiveScale };
}

/**
 * Convert paper mm (a line weight, font size, etc.) to world units, given
 * the same effective scale {@link computeSvgExportViewport} resolved —
 * `mm * scale / 1000`, the inverse ratio `widthMm`/`viewBoxWidth` encodes.
 */
export function svgExportMmToWorld(mm: number, effectiveScale: number): number {
  return (mm * effectiveScale) / 1000;
}
