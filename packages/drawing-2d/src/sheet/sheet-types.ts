/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing Sheet Types
 *
 * Complete drawing sheet configuration combining:
 * - Paper size
 * - Drawing frame
 * - Title block
 * - Scale bar
 * - North arrow
 */

import type { PaperSizeDefinition } from './paper-sizes.js';
import type { DrawingFrame } from './frame-types.js';
import type { TitleBlockConfig, RevisionEntry } from './title-block-types.js';
import type { ScaleBarConfig, NorthArrowConfig } from './scale-bar-types.js';
import type { DrawingScale } from '../styles.js';

/** Viewport bounds in sheet coordinates (mm from sheet origin) */
export interface ViewportBounds {
  /** X position from left edge of paper (mm) */
  x: number;
  /** Y position from top edge of paper (mm) */
  y: number;
  /** Viewport width (mm) */
  width: number;
  /** Viewport height (mm) */
  height: number;
}

/** Complete drawing sheet configuration */
export interface DrawingSheet {
  /** Unique sheet identifier */
  id: string;
  /** Sheet name for display */
  name: string;
  /** Paper size configuration */
  paper: PaperSizeDefinition;
  /** Drawing frame configuration */
  frame: DrawingFrame;
  /** Title block configuration */
  titleBlock: TitleBlockConfig;
  /** Scale bar configuration */
  scaleBar: ScaleBarConfig;
  /** Drawing scale */
  scale: DrawingScale;
  /** North arrow configuration */
  northArrow: NorthArrowConfig;
  /** Calculated viewport bounds (where drawing content goes) */
  viewportBounds: ViewportBounds;
  /** Revision history */
  revisions: RevisionEntry[];
}

/** Sheet creation options */
export interface SheetCreationOptions {
  /** Paper size ID (e.g., 'A3_LANDSCAPE') */
  paperId?: string;
  /** Frame style */
  frameStyle?: string;
  /** Title block layout */
  titleBlockLayout?: string;
  /** Drawing scale */
  scale?: DrawingScale;
}

/**
 * Calculate viewport bounds given sheet configuration
 * The viewport is the area where the actual drawing content is placed
 */
export function calculateViewportBounds(
  paper: PaperSizeDefinition,
  frame: DrawingFrame,
  titleBlock: TitleBlockConfig
): ViewportBounds {
  // Frame inner edges
  const frameInnerLeft =
    frame.margins.left + frame.margins.bindingMargin + frame.border.borderGap;
  const frameInnerRight =
    paper.widthMm - frame.margins.right - frame.border.borderGap;
  const frameInnerTop = frame.margins.top + frame.border.borderGap;
  const frameInnerBottom =
    paper.heightMm - frame.margins.bottom - frame.border.borderGap;

  let viewportX = frameInnerLeft;
  let viewportY = frameInnerTop;
  let viewportWidth = frameInnerRight - frameInnerLeft;
  let viewportHeight = frameInnerBottom - frameInnerTop;

  // Adjust for title block position
  const padding = 5; // Gap between viewport and title block

  switch (titleBlock.position) {
    case 'bottom-right':
      // Title block takes bottom-right corner
      // Viewport can use full width, but may need to avoid title block area
      viewportHeight = frameInnerBottom - frameInnerTop - titleBlock.heightMm - padding;
      break;

    case 'bottom-full':
      // Title block spans full width at bottom
      viewportHeight =
        frameInnerBottom - frameInnerTop - titleBlock.heightMm - padding;
      break;

    case 'right-strip':
      // Title block is a vertical strip on right
      viewportWidth =
        frameInnerRight - frameInnerLeft - titleBlock.widthMm - padding;
      break;
  }

  return {
    x: viewportX,
    y: viewportY,
    width: viewportWidth,
    height: viewportHeight,
  };
}

/**
 * Calculate the transform needed to fit drawing content into viewport
 *
 * @param drawingBounds - Bounds of the 2D drawing in model units (meters)
 * @param viewportBounds - Available viewport in mm
 * @param scale - Drawing scale
 * @returns Transform parameters for SVG
 */
export function calculateDrawingTransform(
  drawingBounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewportBounds: ViewportBounds,
  scale: DrawingScale
): {
  translateX: number;
  translateY: number;
  scaleFactor: number;
} {
  const drawingWidth = drawingBounds.maxX - drawingBounds.minX;
  const drawingHeight = drawingBounds.maxY - drawingBounds.minY;

  // Convert drawing size to paper mm at given scale
  // At 1:100, 1 meter = 10mm on paper
  const paperScale = 1000 / scale.factor;
  const drawingWidthMm = drawingWidth * paperScale;
  const drawingHeightMm = drawingHeight * paperScale;

  // Calculate scale to fit in viewport (with some padding)
  const paddingFactor = 0.95;
  const scaleX = (viewportBounds.width * paddingFactor) / drawingWidthMm;
  const scaleY = (viewportBounds.height * paddingFactor) / drawingHeightMm;
  const fitScale = Math.min(scaleX, scaleY, 1); // Don't scale up beyond 1:1

  const scaleFactor = paperScale * fitScale;

  // Center the drawing in viewport
  const finalWidthMm = drawingWidth * scaleFactor;
  const finalHeightMm = drawingHeight * scaleFactor;

  const translateX =
    viewportBounds.x +
    (viewportBounds.width - finalWidthMm) / 2 -
    drawingBounds.minX * scaleFactor;
  const translateY =
    viewportBounds.y +
    (viewportBounds.height - finalHeightMm) / 2 +
    drawingBounds.maxY * scaleFactor; // Flip Y

  return { translateX, translateY, scaleFactor };
}

/**
 * `calculateDrawingTransform` always derives `translateY` assuming the
 * caller will map model Y to paper Y with a sign flip (`adjustedY = -y`,
 * matching a plan view drawn with north/Y+ up on paper) — it centers using
 * `drawingBounds.maxY` for exactly that reason (see the "Flip Y" comment
 * above).
 *
 * Plan ('down') sections do NOT flip Y (see `Drawing2DCanvas.tsx`'s
 * `flipY = sectionAxis !== 'down'`): they map `adjustedY = y` directly, so
 * north stays up without a sign flip. Reusing the flipped `translateY`
 * unmodified in that case still centers the WIDTH but shifts the centered Y
 * off by `(minY + maxY) * scaleFactor` — the drawing lands off-center on the
 * sheet, worse the further the section's bounds sit from being symmetric
 * about Y=0. This offset was found diverging between the sheet PREVIEW
 * (`Drawing2DCanvas.tsx`, which already carried this correction) and the
 * sheet PRINT/EXPORT path (`useDrawingExport.ts`'s `generateSheetSVG`, which
 * did not) — issue #2940.
 *
 * Call this instead of `calculateDrawingTransform` directly wherever the
 * axis's flip behavior is known, so every sheet consumer (screen preview,
 * print, SVG/PDF export) computes the identical, correctly-centered
 * transform from one place.
 *
 * `translateX` needs the mirror-image correction, but gated the OPPOSITE
 * way from `translateY`: `calculateDrawingTransform`'s `translateX` bakes
 * in the assumption that the caller maps model X to paper X with NO sign
 * flip (`adjustedX = x`) — unlike `translateY`, which bakes in a flip. So
 * `translateX` is only wrong when `flipX` is actually true (`adjustedX =
 * -x`, used for 'side' sections to view from the conventional direction,
 * see `Drawing2DCanvas.tsx` / `useDrawingExport.ts`'s `flipX = sectionAxis
 * === 'side'`): flipping negates and reverses the drawing's X extent to
 * `[-maxX, -minX]`, so the base translate (keyed off `-minX`) shifts the
 * centered box by `(minX + maxX) * scaleFactor` — the drawing lands off
 * the left/right edge of the sheet, worse the further the section's bounds
 * sit from being symmetric about X=0. Confirmed unfixed prior to this
 * change (issue #2940's X-axis half): a 'side' section with bounds minX=2,
 * maxX=12 on a 190mm-wide viewport landed 140mm off-center.
 */
export function calculateDrawingTransformForAxis(
  drawingBounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewportBounds: ViewportBounds,
  scale: DrawingScale,
  flipY: boolean,
  flipX = false
): {
  translateX: number;
  translateY: number;
  scaleFactor: number;
} {
  const base = calculateDrawingTransform(drawingBounds, viewportBounds, scale);
  const translateY = flipY
    ? base.translateY
    : base.translateY - (drawingBounds.maxY + drawingBounds.minY) * base.scaleFactor;
  const translateX = flipX
    ? base.translateX + (drawingBounds.minX + drawingBounds.maxX) * base.scaleFactor
    : base.translateX;
  return { ...base, translateX, translateY };
}
