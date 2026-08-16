/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "As displayed" scale derivation and page-size description for the to-scale
 * 3D-view PDF export (#2042).
 *
 * DEFECT CLASS 1 — the devicePixelRatio double count. The scale a viewport
 * "displays at" is a ratio between world metres and PHYSICAL paper millimetres,
 * and the browser's own physical-size reference is the CSS pixel: 96 CSS px is
 * one inch, by definition, on every display regardless of its backing-store
 * density. A canvas' `width`/`height` attributes are DEVICE pixels
 * (`cssHeight * devicePixelRatio`), so a caller that measures those, or an
 * implementation that "corrects" a CSS measurement by `devicePixelRatio`,
 * reports a scale off by exactly the ratio — 1:151 printed on a sheet labelled
 * 1:76 on a Retina display. Nothing about the resulting PDF looks wrong; only
 * a ruler on the print disagrees. This module therefore takes CSS pixels only
 * and never reads `devicePixelRatio`, and its tests pin that the result does
 * not move when the global changes.
 *
 * DEFECT CLASS 2 — a page that silently exceeds what a PDF can express. The
 * page is sized to the drawing (`computePdfScaleLayout`), never fitted, so a
 * large site at 1:10 asks for metres of paper. PDF's user-space limit is
 * 14400 pt = 200 in = 5080 mm per side; past that a writer either clamps
 * (mis-scaling the very thing that was supposed to be exact) or emits a page a
 * reader refuses. `describePage` surfaces both the nearest ISO sheet that
 * CONTAINS the page and the oversize verdict, so the dialog can warn before
 * anything is written.
 */

import {
  PAPER_SIZE_REGISTRY,
  type PaperSizeDefinition,
  type PdfPage,
} from '@ifc-lite/drawing-2d';

/** CSS pixels per inch — fixed by the CSS spec, not by the display. */
const CSS_PX_PER_INCH = 96;
/** Millimetres per inch. */
const MM_PER_INCH = 25.4;

/**
 * Largest side a PDF page can express: 14400 pt at 72 pt/in = 200 in = 5080 mm.
 */
export const MAX_PDF_PAGE_DIMENSION_MM = 5080;

/** Camera projection mode, as `Camera.getProjectionMode()` reports it. */
export type ViewProjectionMode = 'orthographic' | 'perspective';

/** Everything the displayed scale is a function of. Plain numbers: no camera,
 *  no DOM, no store — so the arithmetic is testable on its own. */
export interface DisplayedScaleInput {
  projectionMode: ViewProjectionMode;
  /** `Camera.getOrthoSize()`: the world half-height (metres) the viewport shows
   *  in orthographic mode (see `camera-matrices.ts`, which builds the ortho
   *  frustum as `[-h*aspect, h*aspect, -h, h]`). */
  orthoSize: number;
  /** `Camera.getDistance()`: metres from the camera to the orbit target. Read
   *  in perspective mode only. */
  distance: number;
  /** `Camera.getFOV()`: the VERTICAL field of view in RADIANS (the renderer
   *  stores radians, e.g. `Math.PI / 4`). Read in perspective mode only. */
  fovRadians: number;
  /** Canvas height in CSS pixels (`canvas.clientHeight` / the layout box) —
   *  NOT `canvas.height`, which is device pixels. */
  canvasCssHeightPx: number;
}

/**
 * World half-height (metres) the viewport currently shows at the orbit target.
 *
 * Perspective uses `distance * tan(fov / 2)`, which is the same expression
 * `Camera.setProjectionMode('orthographic')` uses to derive an `orthoSize` that
 * keeps the model the same size on screen — so "as displayed" means the same
 * thing before and after the user switches modes.
 *
 * Returns `null` for any input that cannot describe a view (non-finite, zero or
 * negative half-height), rather than propagating a NaN into a printed scale.
 */
export function viewHalfHeightMetres(input: DisplayedScaleInput): number | null {
  const half =
    input.projectionMode === 'orthographic'
      ? input.orthoSize
      : input.distance * Math.tan(input.fovRadians / 2);
  if (!Number.isFinite(half) || half <= 0) return null;
  return half;
}

/**
 * The "N" in 1:N that the viewport is currently displaying at, against a
 * nominal 96 dpi screen.
 *
 * `factor = worldHeightMetres * 1000 / screenHeightMm`, i.e. how many
 * millimetres of world one millimetre of screen covers.
 *
 * `null` when the view or the canvas is degenerate — the caller falls back to
 * a preset rather than printing a sheet labelled `1:NaN`.
 */
export function deriveDisplayedScaleFactor(input: DisplayedScaleInput): number | null {
  const halfHeightMetres = viewHalfHeightMetres(input);
  if (halfHeightMetres === null) return null;
  if (!Number.isFinite(input.canvasCssHeightPx) || input.canvasCssHeightPx <= 0) return null;

  const screenHeightMm = (input.canvasCssHeightPx * MM_PER_INCH) / CSS_PX_PER_INCH;
  const worldHeightMm = 2 * halfHeightMetres * 1000;
  const factor = worldHeightMm / screenHeightMm;
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** A page size in millimetres — `computePdfScaleLayout(...).page`, reused
 *  rather than restated so the two cannot drift apart. */
export type PageMm = PdfPage;

export interface PageDescription {
  /** The smallest ISO sheet (either orientation) that fully CONTAINS the page,
   *  or `null` when no ISO sheet does. Informational only: the PDF page is
   *  always sized to the drawing, never fitted to this. */
  paper: PaperSizeDefinition | null;
  /** A side exceeds what a PDF page can express, or is not a usable number. */
  oversize: boolean;
}

/**
 * Describe a page for the export dialog: which ISO sheet it would fit on, and
 * whether it is printable at all.
 *
 * "Fits" means CONTAINS — both page sides are within the sheet's sides — not
 * "is closest to". Reporting the nearest sheet by area would name a sheet the
 * drawing runs off the edge of, which is worse than naming none.
 */
export function describePage(page: PageMm): PageDescription {
  const usable =
    Number.isFinite(page.widthMm) &&
    Number.isFinite(page.heightMm) &&
    page.widthMm > 0 &&
    page.heightMm > 0;
  if (!usable) return { paper: null, oversize: true };

  const oversize =
    page.widthMm > MAX_PDF_PAGE_DIMENSION_MM || page.heightMm > MAX_PDF_PAGE_DIMENSION_MM;

  return { paper: smallestContainingIsoPaper(page), oversize };
}

/**
 * Smallest-area ISO sheet whose width AND height both cover the page.
 *
 * Both orientations of each size are separate registry entries, so scanning
 * the registry covers "either orientation" without transposing anything. Ties
 * (a size and its rotation have equal area) resolve to the entry matching the
 * page's own orientation, then by id, so the answer is deterministic.
 */
function smallestContainingIsoPaper(page: PageMm): PaperSizeDefinition | null {
  const pageIsLandscape = page.widthMm >= page.heightMm;
  let best: PaperSizeDefinition | null = null;
  let bestArea = Infinity;

  for (const paper of Object.values(PAPER_SIZE_REGISTRY)) {
    if (paper.category !== 'ISO') continue;
    if (page.widthMm > paper.widthMm || page.heightMm > paper.heightMm) continue;

    const area = paper.widthMm * paper.heightMm;
    if (area < bestArea) {
      best = paper;
      bestArea = area;
      continue;
    }
    if (area === bestArea && best !== null) {
      const matchesOrientation = (p: PaperSizeDefinition): boolean =>
        (p.orientation === 'landscape') === pageIsLandscape;
      if (matchesOrientation(paper) && !matchesOrientation(best)) best = paper;
      else if (matchesOrientation(paper) === matchesOrientation(best) && paper.id < best.id) best = paper;
    }
  }
  return best;
}
