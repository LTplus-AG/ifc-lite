/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World-to-paper transform for the SVG exporter.
 *
 * Split out of `svg-exporter.ts` unchanged: fitting a drawing's world bounds
 * onto a sheet (and reporting the scale that was actually used) is one
 * cohesive job, separable from turning the fitted geometry into SVG markup.
 * None of these were ever methods in any meaningful sense — they read no
 * `this` — so they are plain functions here.
 */

import type { Point2D, Bounds2D } from './types.js';
import type { PaperSize, DrawingScale } from './styles.js';
import { boundsSize, boundsCenter } from './math.js';
import { formatScaleFactorLabel } from './pdf-scale.js';

export interface Transform2D {
  scale: number;
  offsetX: number;
  offsetY: number;
  flipY: boolean;
  /**
   * True when `scale` (worldToMm) was shrunk below the caller's requested
   * scale to honour the padding guarantee. Drives the title block's
   * "Scale:" label: a clamped export must never print the requested name
   * unchanged (that would be a confidently wrong document — see PR #2131
   * review), so the label is re-derived from the effective scale instead.
   */
  clamped: boolean;
}

/** Non-finite → 0, so one bad corner of a bounding box can't move the rest. */
export function finiteOr0(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function computeTransform(
  bounds: Bounds2D,
  paperSize: PaperSize,
  scale: DrawingScale,
  padding: number
): Transform2D {
  // Sanitise the bounds before anything is derived from them. `boundsSize`
  // and `boundsCenter` are plain min/max arithmetic, so ONE non-finite
  // corner propagates into `center`, from there into `offsetX`/`offsetY`,
  // and from there into every coordinate in the document — a single bad
  // bound moved a perfectly finite line to `x1="NaN"`. Dropping the bad
  // component to 0 contains the damage to the geometry that was actually
  // degenerate; `svgNum` is the second line of defence, not the first.
  const safeBounds: Bounds2D = {
    min: { x: finiteOr0(bounds.min.x), y: finiteOr0(bounds.min.y) },
    max: { x: finiteOr0(bounds.max.x), y: finiteOr0(bounds.max.y) },
  };
  const size = boundsSize(safeBounds);
  const center = boundsCenter(safeBounds);

  // `padding` is a minimum-margin guarantee: it must never consume the
  // whole sheet. An impossible padding (padding*2 >= a paper dimension)
  // used to disable the clamp entirely on that axis, silently falling
  // back to rendering at the full requested scale with no margin at all
  // — the exact failure mode this feature exists to remove, just
  // triggered by an oversized padding instead of an absent one. Clamp
  // `padding` itself to the largest value the shorter paper dimension can
  // still hold (leaving a minimum sliver of usable area) and warn, so the
  // guarantee keeps holding instead of silently lapsing.
  const MIN_AVAILABLE_MM = 1;
  const maxPadding = (Math.min(paperSize.width, paperSize.height) - MIN_AVAILABLE_MM) / 2;
  let effectivePadding = padding;
  if (padding > maxPadding) {
    effectivePadding = Math.max(0, maxPadding);
    // eslint-disable-next-line no-console -- deliberate: caller-visible, not a silent fallback
    console.warn(
      `[drawing-2d] SVGExportOptions.padding (${padding}mm) leaves no usable area on a ` +
        `${paperSize.width}x${paperSize.height}mm sheet; clamped to ${effectivePadding.toFixed(2)}mm.`
    );
  }

  // Available drawing area after the (possibly clamped) padding margin
  const availableWidth = paperSize.width - effectivePadding * 2;
  const availableHeight = paperSize.height - effectivePadding * 2;

  // Scale: world units to mm on paper, at the caller's requested scale
  const requestedWorldToMm = 1000 / scale.factor; // mm per world unit (assuming world is in meters)

  // `padding` is a minimum-margin guarantee, not a forced re-fit: never
  // render closer to the paper edge than `padding` mm. If the drawing at
  // the requested scale already leaves at least that much margin, the
  // exact requested scale is kept unchanged. Otherwise the effective
  // scale is shrunk (never enlarged) just enough to respect the margin.
  let worldToMm = requestedWorldToMm;
  if (size.x > 0 && availableWidth > 0) {
    worldToMm = Math.min(worldToMm, availableWidth / size.x);
  }
  if (size.y > 0 && availableHeight > 0) {
    worldToMm = Math.min(worldToMm, availableHeight / size.y);
  }

  // Center the drawing
  const offsetX = paperSize.width / 2 - center.x * worldToMm;
  const offsetY = paperSize.height / 2 + center.y * worldToMm; // Flip Y

  return {
    scale: worldToMm,
    offsetX,
    offsetY,
    flipY: true,
    clamped: worldToMm !== requestedWorldToMm,
  };
}

/**
 * Label printed in the title block's "Scale:" line.
 *
 * When the drawing was not clamped, the exact requested `scale.name` is
 * returned unchanged (no floating-point round-trip on the common path, so
 * "1:100" never regresses to something like "1:100.0000001"). When the
 * effective scale was shrunk to honour the padding guarantee, the label is
 * re-derived from the *actual* `worldToMm` so a clamped sheet never claims
 * the scale it was requested at but did not render at (PR #2131 review).
 */
export function scaleLabel(scale: DrawingScale, transform: Transform2D): string {
  if (!transform.clamped) {
    return scale.name;
  }
  const effectiveFactor = 1000 / transform.scale;
  return `1:${formatScaleFactorLabel(effectiveFactor)}`;
}

export function transformPoint(point: Point2D, transform: Transform2D): Point2D {
  return {
    x: point.x * transform.scale + transform.offsetX,
    y: transform.flipY
      ? -point.y * transform.scale + transform.offsetY
      : point.y * transform.scale + transform.offsetY,
  };
}
