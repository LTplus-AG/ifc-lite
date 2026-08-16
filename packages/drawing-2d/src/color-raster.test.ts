/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the shaded RGBA underlay of the to-scale PDF export (issue #2042).
 *
 * The section plane used throughout is `{ axis: 'z', position: 0, flipped:
 * false }`, so `signedDepth(p) = p.z`, the KEPT half is `z <= 0`, the view
 * direction is `(0, 0, -1)`, and `projectPointForPlane` is `(p.x, p.y)`.
 * That makes every expected pixel colour and every expected paper coordinate
 * derivable by hand rather than recorded from the implementation.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig } from './types.js';
import {
  buildColorRaster,
  fitRasterPixels,
  DEFAULT_SHADING_DPI,
  MAX_SHADING_PIXELS,
  MAX_SHADING_DIMENSION_PX,
  type ColorRaster,
} from './color-raster.js';
import { computeOccluderBounds } from './hidden-line-raster.js';
import { computePdfScaleLayout, worldPointToPdfMm } from './pdf-scale.js';

const PLANE: SectionPlaneConfig = { axis: 'z', position: 0, flipped: false };
const DEPTH_WINDOW = 20;

type Corner = readonly [number, number, number];

/** A quad from four corners (in ring order), as one two-triangle mesh. */
function quadMesh(
  corners: readonly [Corner, Corner, Corner, Corner],
  color: [number, number, number, number],
  opts: { origin?: [number, number, number]; reverse?: boolean; expressId?: number } = {},
): MeshData {
  const positions = new Float32Array(corners.flatMap((c) => [c[0], c[1], c[2]]));
  const indices = opts.reverse
    ? new Uint32Array([2, 1, 0, 3, 2, 0])
    : new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    expressId: opts.expressId ?? 1,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color,
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
}

/** A flat quad at constant `z`, spanning `[x0,x1] x [y0,y1]`. */
function flatQuad(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
  color: [number, number, number, number],
  opts: { origin?: [number, number, number]; reverse?: boolean } = {},
): MeshData {
  return quadMesh(
    [
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
      [x0, y1, z],
    ],
    color,
    opts,
  );
}

function build(meshes: MeshData[], widthPx = 16, heightPx = 16): ColorRaster {
  const raster = buildColorRaster(meshes, PLANE, DEPTH_WINDOW, { widthPx, heightPx });
  if (!raster) throw new Error('expected a raster for this fixture');
  return raster;
}

/** RGBA of the pixel containing world point (x, y), via the documented mapping. */
function pixelAt(raster: ColorRaster, x: number, y: number): [number, number, number, number] {
  const { i, j } = pixelIndexOf(raster, x, y);
  const o = (j * raster.width + i) * 4;
  return [raster.pixels[o], raster.pixels[o + 1], raster.pixels[o + 2], raster.pixels[o + 3]];
}

function pixelIndexOf(raster: ColorRaster, x: number, y: number): { i: number; j: number } {
  const { bounds, width, height } = raster;
  const u = ((x - bounds.min.x) / (bounds.max.x - bounds.min.x)) * width;
  const v = ((bounds.max.y - y) / (bounds.max.y - bounds.min.y)) * height;
  return {
    i: Math.min(width - 1, Math.max(0, Math.floor(u))),
    j: Math.min(height - 1, Math.max(0, Math.floor(v))),
  };
}

describe('buildColorRaster shading', () => {
  it('paints a viewer-facing surface at full brightness', () => {
    // Normal is (0,0,±1), viewDir is (0,0,-1): |dot| = 1, lambert = 1.
    const raster = build([flatQuad(0, 2, 0, 2, -1, [1, 0, 0, 1])]);
    expect(pixelAt(raster, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it('darkens a tilted surface by exactly 0.4 + 0.6 * |dot(n, viewDir)|', () => {
    // z = -1 - sqrt(3) * x has normal proportional to (sqrt(3), 0, 1), so
    // |dot(n_unit, (0,0,-1))| = 0.5 and lambert = 0.4 + 0.6 * 0.5 = 0.7.
    const s = Math.sqrt(3);
    const mesh = quadMesh(
      [
        [0, 0, -1],
        [2, 0, -1 - 2 * s],
        [2, 2, -1 - 2 * s],
        [0, 2, -1],
      ],
      [1, 1, 1, 1],
    );
    const raster = build([mesh]);
    const [r, g, b, a] = pixelAt(raster, 1, 1);
    expect(r).toBeGreaterThanOrEqual(178);
    expect(r).toBeLessThanOrEqual(180);
    expect(g).toBe(r);
    expect(b).toBe(r);
    expect(a).toBe(255);
  });

  it('never paints a face black: a near edge-on face keeps the ambient term', () => {
    // z = -1 - 100x over x in [0, 0.1]: the normal is proportional to
    // (100, 0, 1), so |dot(n_unit, viewDir)| = 1/sqrt(10001) ~ 0.01 and
    // lambert ~ 0.406 -> 104, not 0.
    const mesh = quadMesh(
      [
        [0, 0, -1],
        [0.1, 0, -11],
        [0.1, 2, -11],
        [0, 2, -1],
      ],
      [1, 1, 1, 1],
    );
    const raster = build([mesh]);
    const [r] = pixelAt(raster, 0.05, 1);
    expect(r).toBe(Math.round(255 * (0.4 + 0.6 / Math.sqrt(10001))));
    expect(r).toBeGreaterThan(100);
  });

  it('is winding independent (IFC winding is unreliable)', () => {
    const s = Math.sqrt(3);
    const corners: readonly [Corner, Corner, Corner, Corner] = [
      [0, 0, -1],
      [2, 0, -1 - 2 * s],
      [2, 2, -1 - 2 * s],
      [0, 2, -1],
    ];
    const forward = build([quadMesh(corners, [0.2, 0.6, 1, 1])]);
    const reversed = build([quadMesh(corners, [0.2, 0.6, 1, 1], { reverse: true })]);
    expect(Array.from(reversed.pixels)).toEqual(Array.from(forward.pixels));
  });

  it('folds MeshData.origin: local positions plus origin match a baked twin', () => {
    const origin: [number, number, number] = [5, 3, -2];
    const local = [
      flatQuad(0, 1, 0, 2, 1, [1, 0, 0, 1], { origin }),
      flatQuad(1, 2, 0, 2, 1, [0, 0, 1, 1], { origin }),
    ];
    // Same geometry with the origin baked into the positions.
    const baked = [
      flatQuad(5, 6, 3, 5, -1, [1, 0, 0, 1]),
      flatQuad(6, 7, 3, 5, -1, [0, 0, 1, 1]),
    ];

    const a = build(local);
    const b = build(baked);

    expect(a.bounds).toEqual(b.bounds);
    expect(Array.from(a.pixels)).toEqual(Array.from(b.pixels));
    // And the content is genuinely two-toned, so an all-transparent raster
    // cannot pass this by matching trivially.
    expect(pixelAt(a, 5.5, 4)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(a, 6.5, 4)).toEqual([0, 0, 255, 255]);
  });
});

describe('buildColorRaster occlusion', () => {
  it('paints the nearer surface where two surfaces overlap', () => {
    // Near red (viewDepth 1) covers the left half; far blue (viewDepth 5)
    // covers the whole extent.
    const far = flatQuad(0, 2, 0, 2, -5, [0, 0, 1, 1]);
    const near = flatQuad(0, 1, 0, 2, -1, [1, 0, 0, 1]);
    const raster = build([far, near]);

    expect(pixelAt(raster, 0.5, 1)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(raster, 1.5, 1)).toEqual([0, 0, 255, 255]);
  });

  it('is draw-order independent: the far surface cannot overwrite the near one', () => {
    const far = flatQuad(0, 2, 0, 2, -5, [0, 0, 1, 1]);
    const near = flatQuad(0, 1, 0, 2, -1, [1, 0, 0, 1]);
    const nearFirst = build([near, far]);
    const farFirst = build([far, near]);
    expect(Array.from(nearFirst.pixels)).toEqual(Array.from(farFirst.pixels));
  });

  it('leaves paper transparent where nothing projects', () => {
    // One triangle covering the lower-left half of its own extent: the
    // opposite corner is inside the bounds but outside the geometry.
    const triangle: MeshData = {
      expressId: 1,
      positions: new Float32Array([0, 0, -1, 2, 0, -1, 0, 2, -1]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    };
    const raster = build([triangle], 32, 32);
    // Inside the triangle.
    expect(pixelAt(raster, 0.3, 0.3)[3]).toBe(255);
    // The opposite corner is outside it.
    expect(pixelAt(raster, 1.9, 1.9)).toEqual([0, 0, 0, 0]);
  });
});

describe('buildColorRaster transparency', () => {
  it('blends a translucent surface over the opaque surface behind it', () => {
    const opaqueBlue = flatQuad(0, 2, 0, 2, -5, [0, 0, 1, 1]);
    const glassRed = flatQuad(0, 2, 0, 2, -1, [1, 0, 0, 0.5]);
    const raster = build([opaqueBlue, glassRed]);

    const [r, g, b, a] = pixelAt(raster, 1, 1);
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(g).toBe(0);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(128);
    expect(a).toBe(255);
  });

  it('drops a translucent surface that sits behind an opaque one', () => {
    const opaqueBlue = flatQuad(0, 2, 0, 2, -1, [0, 0, 1, 1]);
    const glassRedBehind = flatQuad(0, 2, 0, 2, -5, [1, 0, 0, 0.5]);
    const raster = build([opaqueBlue, glassRedBehind]);
    expect(pixelAt(raster, 1, 1)).toEqual([0, 0, 255, 255]);
  });
});

describe('buildColorRaster frame and degradation', () => {
  it('spans exactly the projected extent, with no margin', () => {
    const raster = build([flatQuad(1, 4, 2, 3, -1, [1, 1, 1, 1])]);
    expect(raster.bounds.min.x).toBeCloseTo(1, 12);
    expect(raster.bounds.max.x).toBeCloseTo(4, 12);
    expect(raster.bounds.min.y).toBeCloseTo(2, 12);
    expect(raster.bounds.max.y).toBeCloseTo(3, 12);
  });

  it('keeps the hidden-line raster on its 1% margin (the extraction is behaviour preserving)', () => {
    const meshes = [flatQuad(1, 4, 2, 3, -1, [1, 1, 1, 1])];
    const occluder = computeOccluderBounds(meshes, PLANE, DEPTH_WINDOW);
    // 1% of the larger side (3m) = 0.03m on every side.
    expect(occluder.min.x).toBeCloseTo(1 - 0.03, 9);
    expect(occluder.max.x).toBeCloseTo(4 + 0.03, 9);
    expect(occluder.min.y).toBeCloseTo(2 - 0.03, 9);
    expect(occluder.max.y).toBeCloseTo(3 + 0.03, 9);
  });

  it('spans the extent EDGE to edge, not centre to centre', () => {
    // 10m x 10m extent onto a 10 x 10 grid, so one pixel is exactly 1m and
    // pixel (i, j) is centred on world (i + 0.5, 9.5 - j).
    //
    // The colour boundary at x = 9 therefore falls exactly on the boundary
    // between columns 8 and 9. Under the hidden-line raster's `width - 1`
    // mapping it would land at 8.1 instead, painting column 8 blue and
    // leaving column 9 (world x > 9) off the grid entirely.
    const red = flatQuad(0, 9, 0, 10, -1, [1, 0, 0, 1]);
    const blue = flatQuad(9, 10, 0, 10, -1, [0, 0, 1, 1]);
    const raster = build([red, blue], 10, 10);

    const px = (i: number, j: number) => {
      const o = (j * raster.width + i) * 4;
      return [raster.pixels[o], raster.pixels[o + 1], raster.pixels[o + 2], raster.pixels[o + 3]];
    };
    expect(px(8, 5)).toEqual([255, 0, 0, 255]);
    expect(px(9, 5)).toEqual([0, 0, 255, 255]);
    // The first column and the last row are covered too: an off-by-one in
    // either direction would leave one of them transparent.
    expect(px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(0, 9)).toEqual([255, 0, 0, 255]);
  });

  it('row 0 is the TOP of the drawing (world max.y)', () => {
    const top = flatQuad(0, 2, 1, 2, -1, [1, 0, 0, 1]);
    const bottom = flatQuad(0, 2, 0, 1, -1, [0, 0, 1, 1]);
    const raster = build([top, bottom], 8, 8);
    const firstRow = raster.pixels.slice(0, 4);
    expect(Array.from(firstRow)).toEqual([255, 0, 0, 255]);
  });

  it('returns null when the projected extent is degenerate', () => {
    // Everything on one line in y: zero height.
    const sliver: MeshData = {
      expressId: 1,
      positions: new Float32Array([0, 0, -1, 2, 0, -1, 1, 0, -2]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    };
    expect(buildColorRaster([sliver], PLANE, DEPTH_WINDOW, { widthPx: 8, heightPx: 8 })).toBeNull();
  });

  it('returns null when nothing lands in the kept half', () => {
    // z = +5 is on the cut-away side, so no vertex is in [0, DEPTH_WINDOW].
    const away = flatQuad(0, 2, 0, 2, 5, [1, 0, 0, 1]);
    expect(buildColorRaster([away], PLANE, DEPTH_WINDOW, { widthPx: 8, heightPx: 8 })).toBeNull();
  });

  it('rejects a sub-pixel raster size instead of emitting an empty image', () => {
    const meshes = [flatQuad(0, 2, 0, 2, -1, [1, 1, 1, 1])];
    expect(() => buildColorRaster(meshes, PLANE, DEPTH_WINDOW, { widthPx: 0, heightPx: 8 })).toThrow(
      /Invalid colour raster size/,
    );
  });
});

describe('fitRasterPixels', () => {
  it('converts millimetres to pixels at the requested dpi', () => {
    const fit = fitRasterPixels(100, 50, 150, MAX_SHADING_PIXELS, MAX_SHADING_DIMENSION_PX);
    expect(fit.widthPx).toBe(591); // ceil(100 * 150 / 25.4)
    expect(fit.heightPx).toBe(296); // ceil(50 * 150 / 25.4)
    expect(fit.effectiveDpi).toBe(150);
    expect(fit.capped).toBe(false);
  });

  it('scales both sides by the same factor when the pixel cap engages', () => {
    // A0-ish sheet at 150 dpi asks for ~34.9 megapixels.
    const w = 1189;
    const h = 841;
    const requested =
      Math.ceil((w * DEFAULT_SHADING_DPI) / 25.4) * Math.ceil((h * DEFAULT_SHADING_DPI) / 25.4);
    expect(requested).toBeGreaterThan(MAX_SHADING_PIXELS);

    const fit = fitRasterPixels(w, h, DEFAULT_SHADING_DPI, MAX_SHADING_PIXELS, MAX_SHADING_DIMENSION_PX);
    expect(fit.capped).toBe(true);
    expect(fit.widthPx * fit.heightPx).toBeLessThanOrEqual(MAX_SHADING_PIXELS);

    const scale = Math.sqrt(MAX_SHADING_PIXELS / requested);
    expect(fit.effectiveDpi).toBeCloseTo(DEFAULT_SHADING_DPI * scale, 6);
    // Aspect preserved: both sides scaled by `scale`, then floored.
    expect(Math.abs(fit.widthPx / fit.heightPx - w / h)).toBeLessThan(0.001);
  });

  it('caps a long thin sheet on its longest side', () => {
    // 6000 x 10 mm at 150 dpi is only ~2.1 megapixels, under the area cap,
    // but 35,433 px wide - over the per-side cap.
    const fit = fitRasterPixels(6000, 10, 150, MAX_SHADING_PIXELS, MAX_SHADING_DIMENSION_PX);
    expect(fit.capped).toBe(true);
    expect(fit.widthPx).toBeLessThanOrEqual(MAX_SHADING_DIMENSION_PX);
    expect(fit.heightPx).toBeGreaterThanOrEqual(1);
  });

  it('rejects a non-positive or non-finite request', () => {
    expect(() => fitRasterPixels(Number.NaN, 50, 150, MAX_SHADING_PIXELS, MAX_SHADING_DIMENSION_PX)).toThrow(
      /Invalid shading raster/,
    );
    expect(() => fitRasterPixels(100, 50, 0, MAX_SHADING_PIXELS, MAX_SHADING_DIMENSION_PX)).toThrow(
      /Invalid shading raster/,
    );
  });
});

describe('raster / stroke registration on the PDF page', () => {
  /**
   * The whole feature hinges on the image landing where the strokes land.
   * Push a world point through the STROKE path (`worldPointToPdfMm`) and
   * through the IMAGE path (the placement rectangle plus the pixel the point
   * falls in) and require them to agree to within half a pixel.
   */
  it('places a pixel within half a pixel of the same point drawn as a stroke', () => {
    const meshes = [
      flatQuad(3, 7, 11, 13, -1, [1, 0, 0, 1]),
      flatQuad(7, 9, 11, 12, -3, [0, 0, 1, 1]),
    ];
    const raster = build(meshes, 220, 130);

    const marginMm = 10;
    const { transform } = computePdfScaleLayout(raster.bounds, 100, marginMm);

    const topLeft = worldPointToPdfMm({ x: raster.bounds.min.x, y: raster.bounds.max.y }, transform);
    const rectWMm = (raster.bounds.max.x - raster.bounds.min.x) * transform.worldToMm;
    const rectHMm = (raster.bounds.max.y - raster.bounds.min.y) * transform.worldToMm;
    const pixelWMm = rectWMm / raster.width;
    const pixelHMm = rectHMm / raster.height;

    for (const p of [
      { x: 3, y: 13 }, // top-left corner of the extent
      { x: 9, y: 11 }, // bottom-right corner
      { x: 5.37, y: 12.11 },
      { x: 8.2, y: 11.9 },
    ]) {
      const stroke = worldPointToPdfMm(p, transform);
      const { i, j } = pixelIndexOf(raster, p.x, p.y);
      const imageX = topLeft.x + ((i + 0.5) / raster.width) * rectWMm;
      const imageY = topLeft.y + ((j + 0.5) / raster.height) * rectHMm;

      expect(Math.abs(stroke.x - imageX)).toBeLessThanOrEqual(0.5 * pixelWMm + 1e-9);
      expect(Math.abs(stroke.y - imageY)).toBeLessThanOrEqual(0.5 * pixelHMm + 1e-9);
    }
  });

  it('places the image rectangle at the exact scaled size of the extent', () => {
    // A 4m x 2m quad at 1:100 must occupy exactly 40mm x 20mm of paper.
    const raster = build([flatQuad(0, 4, 0, 2, -1, [1, 1, 1, 1])]);
    const { transform } = computePdfScaleLayout(raster.bounds, 100, 10);
    const rectWMm = (raster.bounds.max.x - raster.bounds.min.x) * transform.worldToMm;
    const rectHMm = (raster.bounds.max.y - raster.bounds.min.y) * transform.worldToMm;
    expect(rectWMm).toBeCloseTo(40, 9);
    expect(rectHMm).toBeCloseTo(20, 9);
  });
});
