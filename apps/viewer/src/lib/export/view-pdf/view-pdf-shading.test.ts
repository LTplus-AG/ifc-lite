/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the shaded underlay lands on the paper, and what it does when it
 * cannot be produced (#2042).
 *
 * DEFECT CLASS 1 — an image sized from its own pixels. `width / dpi` is the
 * obvious way to place a raster and it is wrong here: the rasteriser is allowed
 * to cap its resolution, so a capped sheet would print smaller at the same
 * nominal scale while every vector stroke stayed put. The tests below place the
 * SAME world rectangle at two scales and at two resolutions, and assert the
 * millimetres follow the scale and ignore the resolution.
 *
 * DEFECT CLASS 2 — a sheet that quietly loses its shading. A rasteriser with
 * nothing to draw must degrade to line work (this file asserts nothing is
 * drawn and the caller is told so), while an encoder that FAILS must reject
 * the export rather than hand back a monochrome sheet that looks deliberate.
 *
 * The rasteriser and the encoder are injected, so none of this needs a canvas
 * or the rasteriser itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePdfScaleLayout, type Bounds2D, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import {
  VIEW_PDF_SHADING_DPI,
  encodeRasterPng,
  placeShadedUnderlay,
  type ShadingRasterRequest,
  type ShadingRasterResult,
  type ViewPdfImageTarget,
} from './view-pdf-shading.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** 4 m wide, 3 m tall, centred on the basis origin. */
const BOUNDS: Bounds2D = { min: { x: -2, y: -1.5 }, max: { x: 2, y: 1.5 } };

const PLANE: SectionPlaneConfig = { axis: 'z', position: 0, flipped: false };

const MARGIN_MM = 10;

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

interface RecordedImage {
  bytes: Uint8Array;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

function imageRecorder(): { images: RecordedImage[]; doc: ViewPdfImageTarget } {
  const images: RecordedImage[] = [];
  return {
    images,
    doc: {
      addImage: (bytes, xMm, yMm, widthMm, heightMm) => {
        images.push({ bytes, xMm, yMm, widthMm, heightMm });
      },
    },
  };
}

/**
 * A stand-in rasteriser honouring the contract `buildColorRaster` is specified
 * against: the returned `bounds` are the projected extent with NO margin, and
 * the pixel grid spans exactly those bounds.
 */
function rasterOf(
  bounds: Bounds2D,
  widthPx: number,
  heightPx: number,
  effectiveDpi = VIEW_PDF_SHADING_DPI,
): ShadingRasterResult {
  return {
    raster: {
      pixels: new Uint8ClampedArray(Math.max(1, widthPx * heightPx * 4)),
      width: widthPx,
      height: heightPx,
      bounds,
    },
    fit: {
      widthPx,
      heightPx,
      effectiveDpi,
      capped: effectiveDpi < VIEW_PDF_SHADING_DPI,
    },
  };
}

const NO_MESHES: readonly MeshData[] = [];

function underlayInput(scaleFactor: number) {
  const layout = computePdfScaleLayout(BOUNDS, scaleFactor, MARGIN_MM);
  return {
    layout,
    input: {
      meshes: NO_MESHES,
      plane: PLANE,
      viewDepth: 25,
      drawingWidthMm: layout.page.widthMm - MARGIN_MM * 2,
      drawingHeightMm: layout.page.heightMm - MARGIN_MM * 2,
      transform: layout.transform,
    },
  };
}

const EXACT = 1e-9;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('placeShadedUnderlay (#2042)', () => {
  it('places the image at the world rectangle, through the strokes own transform', async () => {
    const { images, doc } = imageRecorder();
    const { input } = underlayInput(100);

    const placed = await placeShadedUnderlay(doc, {
      ...input,
      buildRaster: async () => rasterOf(BOUNDS, 236, 177),
      encodePng: async () => PNG,
    });

    assert.equal(images.length, 1, 'exactly one image belongs on a sheet');
    const image = images[0];
    // 4 m x 3 m at 1:100 is 40 x 30 mm, and the drawing starts at the margin.
    assert.ok(Math.abs(image.xMm - MARGIN_MM) < EXACT, `x ${image.xMm}`);
    assert.ok(Math.abs(image.yMm - MARGIN_MM) < EXACT, `y ${image.yMm}`);
    assert.ok(Math.abs(image.widthMm - 40) < EXACT, `width ${image.widthMm}`);
    assert.ok(Math.abs(image.heightMm - 30) < EXACT, `height ${image.heightMm}`);
    assert.deepEqual(image.bytes, PNG, 'the encoder output must be what gets placed');
    assert.equal(placed?.widthPx, 236);
    assert.equal(placed?.heightPx, 177);
  });

  it('doubles the printed image when the scale factor halves', async () => {
    const at100 = imageRecorder();
    const at50 = imageRecorder();
    // The SAME raster at both scales: if the placement read the pixel grid
    // instead of the world bounds, both sheets would print the same size.
    const raster = async () => rasterOf(BOUNDS, 236, 177);

    await placeShadedUnderlay(at100.doc, {
      ...underlayInput(100).input,
      buildRaster: raster,
      encodePng: async () => PNG,
    });
    await placeShadedUnderlay(at50.doc, {
      ...underlayInput(50).input,
      buildRaster: raster,
      encodePng: async () => PNG,
    });

    const a = at100.images[0];
    const b = at50.images[0];
    assert.ok(Math.abs(b.widthMm - 2 * a.widthMm) < EXACT, `${b.widthMm} vs ${a.widthMm}`);
    assert.ok(Math.abs(b.heightMm - 2 * a.heightMm) < EXACT, `${b.heightMm} vs ${a.heightMm}`);
    // The margin is a fixed paper distance, so the top-left corner does not move.
    assert.ok(Math.abs((b.xMm - MARGIN_MM) - 2 * (a.xMm - MARGIN_MM)) < EXACT);
    assert.ok(Math.abs((b.yMm - MARGIN_MM) - 2 * (a.yMm - MARGIN_MM)) < EXACT);
  });

  it('prints the same rectangle when the rasteriser caps its resolution', async () => {
    const sharp = imageRecorder();
    const capped = imageRecorder();
    const { input } = underlayInput(100);

    await placeShadedUnderlay(sharp.doc, {
      ...input,
      buildRaster: async () => rasterOf(BOUNDS, 236, 177),
      encodePng: async () => PNG,
    });
    const placed = await placeShadedUnderlay(capped.doc, {
      ...input,
      // A quarter of the pixels on each side: 37.5 dpi instead of 150.
      buildRaster: async () => rasterOf(BOUNDS, 59, 44, 37.5),
      encodePng: async () => PNG,
    });

    assert.ok(Math.abs(capped.images[0].widthMm - sharp.images[0].widthMm) < EXACT);
    assert.ok(Math.abs(capped.images[0].heightMm - sharp.images[0].heightMm) < EXACT);
    // ...and the caller is told the truth about sharpness, so the dialog can
    // say so rather than claim a resolution the sheet does not have.
    assert.equal(placed?.dpi, 37.5);
    assert.equal(placed?.widthPx, 59);
  });

  it('asks the rasteriser for the drawing area at the viewer resolution', async () => {
    const { doc } = imageRecorder();
    const { input, layout } = underlayInput(100);
    const seen: ShadingRasterRequest[] = [];

    await placeShadedUnderlay(doc, {
      ...input,
      buildRaster: async (request) => {
        seen.push(request);
        return rasterOf(BOUNDS, 236, 177);
      },
      encodePng: async () => PNG,
    });

    assert.equal(seen.length, 1);
    // The page is 60 x 50 mm; the ink area is the 40 x 30 mm inside the margins.
    // Fitting pixels to the whole page would over-resolve it by a fifth.
    assert.ok(Math.abs(seen[0].drawingWidthMm - 40) < EXACT, `${seen[0].drawingWidthMm}`);
    assert.ok(Math.abs(seen[0].drawingHeightMm - 30) < EXACT, `${seen[0].drawingHeightMm}`);
    assert.equal(seen[0].dpi, VIEW_PDF_SHADING_DPI);
    assert.equal(seen[0].viewDepth, 25);
    assert.equal(seen[0].plane, PLANE, 'the raster must use the export plane, not a rebuilt one');
    assert.ok(layout.page.widthMm > seen[0].drawingWidthMm);
  });

  it('degrades to line work when the rasteriser has nothing to draw', async () => {
    const { images, doc } = imageRecorder();
    let encoded = 0;
    const placed = await placeShadedUnderlay(doc, {
      ...underlayInput(100).input,
      buildRaster: async () => ({
        raster: null,
        fit: { widthPx: 0, heightPx: 0, effectiveDpi: VIEW_PDF_SHADING_DPI, capped: false },
      }),
      encodePng: async () => { encoded++; return PNG; },
    });

    assert.equal(placed, null, 'the caller must learn there is no shading');
    assert.deepEqual(images, [], 'nothing may be drawn');
    assert.equal(encoded, 0, 'and nothing may be encoded');
  });

  it('degrades to line work when the raster rectangle collapses', async () => {
    const { images, doc } = imageRecorder();
    const flat: Bounds2D = { min: { x: 1, y: -1.5 }, max: { x: 1, y: 1.5 } };
    const placed = await placeShadedUnderlay(doc, {
      ...underlayInput(100).input,
      buildRaster: async () => rasterOf(flat, 1, 177),
      encodePng: async () => PNG,
    });

    assert.equal(placed, null);
    assert.deepEqual(images, [], 'a zero-width image must not be placed at all');
  });

  it('degrades to line work when the drawing itself is edge-on', async () => {
    // A planar element seen along its own plane, or a section slider dragged
    // onto a face, leaves a drawing with zero extent on one axis. The real
    // pixel fit refuses a non-positive size — rightly, it will not invent a
    // grid — and letting that out rejects the whole export over the one part of
    // the sheet that is optional.
    //
    // The rasteriser is NOT injected here on purpose: the shipped
    // `buildShadingRaster` and its real `fitRasterPixels` are the thing that
    // throws, and a stub would accept a zero-width request without complaint.
    for (const degenerate of [
      { drawingWidthMm: 0, drawingHeightMm: 30 },
      { drawingWidthMm: 40, drawingHeightMm: 0 },
      { drawingWidthMm: Number.NaN, drawingHeightMm: 30 },
    ]) {
      const { images, doc } = imageRecorder();
      const placed = await placeShadedUnderlay(doc, {
        ...underlayInput(100).input,
        ...degenerate,
      });
      assert.equal(placed, null, `${JSON.stringify(degenerate)} must degrade, not throw`);
      assert.deepEqual(images, [], 'nothing may be drawn');
    }
  });

  it('fails the export loudly when the encoder fails', async () => {
    const { images, doc } = imageRecorder();
    await assert.rejects(
      placeShadedUnderlay(doc, {
        ...underlayInput(100).input,
        buildRaster: async () => rasterOf(BOUNDS, 236, 177),
        encodePng: async () => { throw new Error('canvas is out of memory'); },
      }),
      /out of memory/,
    );
    assert.deepEqual(images, [], 'a half-written sheet must not be handed to the writer');
  });

  it('reports the progress stages the dialog labels', async () => {
    const { doc } = imageRecorder();
    const stages: string[] = [];
    await placeShadedUnderlay(doc, {
      ...underlayInput(100).input,
      buildRaster: async () => rasterOf(BOUNDS, 236, 177),
      encodePng: async () => PNG,
      onProgress: (stage) => { stages.push(stage); },
    });
    assert.deepEqual(stages, ['shading', 'encoding']);
  });
});

describe('encodeRasterPng (#2042)', () => {
  it('names the way out when the runtime has no OffscreenCanvas', async () => {
    // Node is exactly that runtime, which is why this can be asserted here at
    // all: a silent catch would hand back an unshaded sheet and look fine.
    assert.equal(typeof OffscreenCanvas, 'undefined', 'this test needs a canvas-free runtime');
    await assert.rejects(
      encodeRasterPng({
        pixels: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
        bounds: BOUNDS,
      }),
      /OffscreenCanvas.*line work mode/s,
    );
  });
});
