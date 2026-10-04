/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canvas drawing of the scan section layer: the slab's dots (#1805) and its
 * traced vector outline (#6871), both already in drawing space.
 */

import type { ScanBandPoint } from '@/hooks/scanSectionMath';
import { SCAN_OUTLINE_COLOR } from '@/lib/scan-outline/scan-outline';

/** Outline stroke width in screen pixels, constant across zoom like the dots. */
const SCAN_OUTLINE_WIDTH_PX = 1.5;

/** Stroke every ring as a closed path. */
function drawScanOutline(
  ctx: CanvasRenderingContext2D,
  rings: readonly (readonly { x: number; y: number }[])[] | undefined,
  modelToScreen: (x: number, y: number) => { x: number; y: number },
): void {
  if (!rings || rings.length === 0) return;
  ctx.save();
  ctx.strokeStyle = SCAN_OUTLINE_COLOR;
  ctx.lineWidth = SCAN_OUTLINE_WIDTH_PX;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((p, i) => {
      const s = modelToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

/** Dot half-size in screen pixels — constant regardless of zoom, like the DXF underlay's text. */
const SCAN_DOT_HALF_PX = 0.75;
const SCAN_DOT_NEUTRAL_COLOR = '#8a8a8a';

/**
 * Render the point-cloud scan overlay (issue #1805), in screen pixels.
 * `scanPoints` already live in the drawing's native 2D coordinate space —
 * `scanSectionMath.ts` projects them with the SAME `projectTo2D` /
 * `projectTo2DBasis` functions the section cutter uses for `cutPolygons` /
 * `lines` — so the caller supplies the plain drawing→screen transform, same
 * as `drawDxfUnderlaysScreenSpace`.
 *
 * Dots draw as tiny filled squares (`fillRect`), not circles: at up to the
 * 500k-point render cap, skipping `beginPath`/`arc`/`fill` per point matters
 * — `fillRect` is a single cheap call with no path tessellation, and at
 * ~1-1.5px a square reads the same as a disc anyway. `fillStyle` is still
 * set per point (colour varies point-to-point for RGB scans); the
 * perf-sensitive part being avoided is the path/arc machinery, not the
 * fillStyle assignment itself.
 *
 * The traced outline (#6871), when given, is stroked first so the dots stay
 * readable on top of it.
 */
export function drawScanSectionScreenSpace(
  ctx: CanvasRenderingContext2D,
  points: readonly ScanBandPoint[] | undefined,
  modelToScreen: (x: number, y: number) => { x: number; y: number },
  opacity: number,
  outline?: readonly (readonly { x: number; y: number }[])[],
): void {
  drawScanOutline(ctx, outline, modelToScreen);
  if (!points || points.length === 0 || opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  const size = SCAN_DOT_HALF_PX * 2;
  for (const p of points) {
    const screen = modelToScreen(p.point.x, p.point.y);
    ctx.fillStyle = p.color
      ? `rgb(${Math.round(p.color[0] * 255)}, ${Math.round(p.color[1] * 255)}, ${Math.round(p.color[2] * 255)})`
      : SCAN_DOT_NEUTRAL_COLOR;
    ctx.fillRect(screen.x - SCAN_DOT_HALF_PX, screen.y - SCAN_DOT_HALF_PX, size, size);
  }
  ctx.restore();
}
