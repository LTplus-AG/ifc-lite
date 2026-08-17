/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shaded underlay of the to-scale 3D-view PDF: a raster of the surfaces,
 * placed at an EXACT millimetre rectangle, with the vector line work drawn on
 * top of it (#2042).
 *
 * WHY A RASTER AND NOT FILLED PATHS. A vector fill needs one filled path per
 * triangle, and the order those paths have to be painted in is undefined the
 * moment two faces interpenetrate — which IFC geometry does constantly. Sorting
 * that correctly is a BSP build, i.e. a second CSG kernel, and the page stream
 * for a real model would run to tens of megabytes. A raster resolves occlusion
 * per pixel, the way the viewport the user is comparing against does.
 *
 * WHY THAT DOES NOT COST THE SCALE CONTRACT — the thing this whole export
 * exists for. Pixels never carry a measurement here. The image is placed by
 * pushing the raster's OWN world bounds through the SAME `PdfScaleTransform`
 * every stroke goes through (`worldPointToPdfMm`), so the rectangle is exact
 * whatever the pixel count is; a capped resolution costs sharpness and nothing
 * else. Every line an engineer measures against stays vector. There is
 * deliberately no second scale, no second offset and no second Y flip in this
 * file: row 0 of the raster is world `bounds.max.y`, which `worldPointToPdfMm`
 * maps to the top of the paper.
 *
 * SEAMS. The rasteriser, the PNG encoder and the document are all injected, so
 * the whole placement path runs under `node:test` with no `OffscreenCanvas`, no
 * jsPDF and no rasteriser. The defaults are the real ones. Nothing here
 * swallows a failure: a rejected encoder rejects the export, because a sheet
 * that silently lost its shading looks exactly like a sheet that never had any.
 */

import {
  MAX_SHADING_DIMENSION_PX,
  MAX_SHADING_PIXELS,
  buildColorRaster,
  fitRasterPixels,
  worldPointToPdfMm,
  type ColorRaster,
  type PdfScaleTransform,
  type RasterFit,
  type SectionPlaneConfig,
} from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';

// ═══════════════════════════════════════════════════════════════════════════
// SEAM SHAPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The one document call this module makes. Kept separate from the full
 * `ViewPdfDocument` so the writer and the underlay do not import each other.
 */
export interface ViewPdfImageTarget {
  addImage(
    pngBytes: Uint8Array,
    xMm: number,
    yMm: number,
    widthMm: number,
    heightMm: number,
  ): void;
}

export type ViewPdfPngEncoder = (raster: ColorRaster) => Promise<Uint8Array>;

/** What the rasteriser is asked for: geometry, frame, and paper size. */
export interface ShadingRasterRequest {
  /** Post-clip meshes — the same ones the line work is generated from. */
  meshes: readonly MeshData[];
  /** The camera plane from `buildCameraSectionPlane`, verbatim. */
  plane: SectionPlaneConfig;
  /** Depth of the solid band in front of the plane (`viewDepth`). */
  viewDepth: number;
  /** Paper size of the DRAWING area (page minus margins), millimetres. */
  drawingWidthMm: number;
  drawingHeightMm: number;
  /** Requested dots per inch ON PAPER, before any cap. */
  dpi: number;
}

/** A raster plus the resolution that was actually achievable for it. */
export interface ShadingRasterResult {
  /** `null` when nothing projects into the view window — see `placeShadedUnderlay`. */
  raster: ColorRaster | null;
  fit: RasterFit;
}

export type ViewPdfRasterBuilder = (
  request: ShadingRasterRequest,
) => Promise<ShadingRasterResult>;

/**
 * Dots per inch of paper the viewer asks the rasteriser for.
 *
 * A policy choice, not a limit: 150 dpi puts a raster pixel at 0.169 mm, so the
 * worst-case registration error against the vector strokes is half of that,
 * comfortably under the 0.13 mm thinnest line. The rasteriser applies its own
 * memory caps on top and reports what it could actually deliver.
 */
export const VIEW_PDF_SHADING_DPI = 150;

// ═══════════════════════════════════════════════════════════════════════════
// PLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

export interface ShadedUnderlayInput extends Omit<ShadingRasterRequest, 'dpi'> {
  /** The layout transform the strokes use. Must be the SAME object. */
  transform: PdfScaleTransform;
  dpi?: number;
  buildRaster?: ViewPdfRasterBuilder;
  encodePng?: ViewPdfPngEncoder;
  onProgress?: (stage: string, progress: number) => void;
}

/** Where the image landed and how sharp it is, for the toast and analytics. */
export interface ShadedUnderlayPlacement {
  widthPx: number;
  heightPx: number;
  /** The dpi actually achieved, which is below the request when capped. */
  dpi: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/**
 * Rasterise `input.meshes` and place the image on `doc`.
 *
 * Returns `null` — having drawn nothing — when the drawing area itself is
 * degenerate (an edge-on view), when the rasteriser reports no usable pixels,
 * or when the rectangle degenerates. That is deliberate: a shaded export must
 * never fail where a line-work export would have succeeded, so the caller
 * carries on and writes the strokes. A rasteriser or encoder that THROWS is a
 * different thing entirely and propagates.
 *
 * Call this BEFORE any stroke: PDF paints in call order, so the underlay has
 * to be written first for the line work to sit on top of it.
 */
export async function placeShadedUnderlay(
  doc: ViewPdfImageTarget,
  input: ShadedUnderlayInput,
): Promise<ShadedUnderlayPlacement | null> {
  const build = input.buildRaster ?? buildShadingRaster;
  const encode = input.encodePng ?? encodeRasterPng;

  // An edge-on view is a real thing to ask for: a planar element seen along its
  // own plane projects to a LINE, so the drawing has zero extent on one axis.
  // `fitRasterPixels` refuses a non-positive size (rightly — it will not invent
  // a pixel grid), and letting that reach the user rejects the whole export
  // with a raw internal string over the one part of the sheet that is optional.
  // The strokes are still exact and still to scale, so degrade to line work,
  // which is what this function already does for every other reason a raster
  // cannot be produced.
  if (
    !Number.isFinite(input.drawingWidthMm) || !Number.isFinite(input.drawingHeightMm) ||
    input.drawingWidthMm <= 0 || input.drawingHeightMm <= 0
  ) {
    return null;
  }

  input.onProgress?.('shading', 0);
  const { raster, fit } = await build({
    meshes: input.meshes,
    plane: input.plane,
    viewDepth: input.viewDepth,
    drawingWidthMm: input.drawingWidthMm,
    drawingHeightMm: input.drawingHeightMm,
    dpi: input.dpi ?? VIEW_PDF_SHADING_DPI,
  });
  if (!raster) return null;

  const rect = imageRectMm(raster, input.transform);
  if (!rect) return null;

  input.onProgress?.('encoding', 0.5);
  const pngBytes = await encode(raster);
  doc.addImage(pngBytes, rect.xMm, rect.yMm, rect.widthMm, rect.heightMm);

  return {
    widthPx: raster.width,
    heightPx: raster.height,
    dpi: fit.effectiveDpi,
    ...rect,
  };
}

/**
 * The image's paper rectangle, from the raster's own world bounds through the
 * export's one transform.
 *
 * Note what is NOT in here: the pixel counts. Placing the image from
 * `width / dpi` instead would tie the printed size to the resolution, so a
 * capped raster would print a smaller sheet at the same nominal scale — the
 * dimensional defect this feature exists to avoid.
 */
function imageRectMm(
  raster: ColorRaster,
  transform: PdfScaleTransform,
): { xMm: number; yMm: number; widthMm: number; heightMm: number } | null {
  const { min, max } = raster.bounds;
  // World max.y is the TOP of the drawing, and row 0 of the raster is that same
  // edge; `worldPointToPdfMm` supplies the single paper Y flip.
  const topLeft = worldPointToPdfMm({ x: min.x, y: max.y }, transform);
  const widthMm = (max.x - min.x) * transform.worldToMm;
  const heightMm = (max.y - min.y) * transform.worldToMm;
  if (
    !Number.isFinite(topLeft.x) || !Number.isFinite(topLeft.y) ||
    !Number.isFinite(widthMm) || !Number.isFinite(heightMm) ||
    widthMm <= 0 || heightMm <= 0
  ) {
    return null;
  }
  return { xMm: topLeft.x, yMm: topLeft.y, widthMm, heightMm };
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT SEAMS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The real rasteriser.
 *
 * The fit arithmetic and its memory caps deliberately stay in
 * `@ifc-lite/drawing-2d` next to the rasteriser that has to honour them: a
 * second copy of that sum here could drift into asking for a pixel count the
 * rasteriser would refuse, and the viewer would have no way to notice.
 */
export const buildShadingRaster: ViewPdfRasterBuilder = async (request) => {
  const fit = fitRasterPixels(
    request.drawingWidthMm,
    request.drawingHeightMm,
    request.dpi,
    MAX_SHADING_PIXELS,
    MAX_SHADING_DIMENSION_PX,
  );
  const raster = buildColorRaster(request.meshes, request.plane, request.viewDepth, {
    widthPx: fit.widthPx,
    heightPx: fit.heightPx,
  });
  return { raster, fit };
};

/**
 * PNG bytes for a raster, via `OffscreenCanvas`.
 *
 * No PNG library enters the repo for this: the browser already has an encoder,
 * and the raster is straight-alpha RGBA8 in exactly `ImageData` layout. A
 * runtime without `OffscreenCanvas` gets a message naming the way out rather
 * than a stack trace, and never a silently unshaded sheet.
 */
export const encodeRasterPng: ViewPdfPngEncoder = async (raster) => {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error(
      'Shaded export needs a browser with OffscreenCanvas. Use the line work mode instead.',
    );
  }
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(
      'Shaded export could not open a 2D canvas for the shading image. Use the line work mode instead.',
    );
  }
  // Copied into the context's own buffer rather than wrapped: an `ImageData`
  // may not be built over a `SharedArrayBuffer`, and the raster is allowed to
  // come from one. The copy is a single pass over bytes the encoder is about to
  // read anyway.
  const image = ctx.createImageData(raster.width, raster.height);
  image.data.set(raster.pixels);
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
};
