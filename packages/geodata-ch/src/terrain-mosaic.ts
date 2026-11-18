/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure raster arithmetic for the terrain reader: a mosaic on a global
 * pixel grid, filled from tiles, then bilinearly sampled at grid nodes.
 *
 * The global grid has pixel size `g` and pixel (i, j) covers
 * x ∈ [i·g, (i+1)·g] and y ∈ [−(j+1)·g, −j·g] (rows run north to south), so
 * every tile whose origin is a multiple of `g` lands on it exactly and a
 * node near a tile edge reads its neighbours from the adjacent tile.
 */

import type { BBox } from './contracts.js';

export interface Mosaic {
  /** Pixel size in metres. */
  g: number;
  /** Global column / row of mosaic pixel (0, 0). */
  i0: number;
  j0: number;
  width: number;
  height: number;
  /** Row-major, `NaN` where no tile supplied data. */
  data: Float32Array;
}

/** Node layout of an output grid over `bbox` at `resolution`. */
export function gridShape(bbox: BBox, resolution: number): { width: number; height: number } {
  const eps = 1e-9;
  return {
    width: Math.floor((bbox.maxX - bbox.minX) / resolution + eps) + 1,
    height: Math.floor((bbox.maxY - bbox.minY) / resolution + eps) + 1,
  };
}

/** Allocate the smallest mosaic whose pixels cover bilinear support for every node in `bbox`. */
export function createMosaic(bbox: BBox, g: number): Mosaic {
  const i0 = Math.floor(bbox.minX / g - 0.5);
  const i1 = Math.floor(bbox.maxX / g - 0.5) + 1;
  const j0 = Math.floor(-bbox.maxY / g - 0.5);
  const j1 = Math.floor(-bbox.minY / g - 0.5) + 1;
  const width = i1 - i0 + 1;
  const height = j1 - j0 + 1;
  return { g, i0, j0, width, height, data: new Float32Array(width * height).fill(Number.NaN) };
}

/** The mosaic's footprint in metres. */
export function mosaicBBox(m: Mosaic): BBox {
  return {
    minX: m.i0 * m.g,
    maxX: (m.i0 + m.width) * m.g,
    minY: -(m.j0 + m.height) * m.g,
    maxY: -m.j0 * m.g,
  };
}

/** Global pixel index of a coordinate that must sit on the grid. */
export function gridIndex(v: number, g: number, what: string): number {
  const k = v / g;
  const r = Math.round(k);
  if (Math.abs(k - r) > 1e-6) throw new Error(`${what} ${v} is not a multiple of pixel size ${g}`);
  return r;
}

export interface TilePlacement {
  /** Tile's top-left corner, metres. */
  originX: number;
  originY: number;
  /** Tile size in pixels. */
  width: number;
  height: number;
}

/**
 * The part of a tile that overlaps the mosaic: a geotiff-style pixel window
 * `[col0, row0, col1, row1)` in tile pixels and where it lands in the
 * mosaic. `null` when they do not overlap.
 */
export function tileWindow(
  m: Mosaic,
  t: TilePlacement,
): { window: [number, number, number, number]; destCol: number; destRow: number } | null {
  const ti = gridIndex(t.originX, m.g, 'tile origin x');
  const tj = gridIndex(-t.originY, m.g, 'tile origin y');
  const c0 = Math.max(0, m.i0 - ti);
  const r0 = Math.max(0, m.j0 - tj);
  const c1 = Math.min(t.width, m.i0 + m.width - ti);
  const r1 = Math.min(t.height, m.j0 + m.height - tj);
  if (c0 >= c1 || r0 >= r1) return null;
  return { window: [c0, r0, c1, r1], destCol: ti + c0 - m.i0, destRow: tj + r0 - m.j0 };
}

/** Copy a window read from a tile into the mosaic, turning `noData` into `NaN`. */
export function blit(
  m: Mosaic,
  src: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  destCol: number,
  destRow: number,
  noData: number | null,
): void {
  for (let r = 0; r < srcHeight; r++) {
    const rowOff = (destRow + r) * m.width + destCol;
    for (let c = 0; c < srcWidth; c++) {
      const v = src[r * srcWidth + c];
      m.data[rowOff + c] = noData !== null && v === noData ? Number.NaN : v;
    }
  }
}

/**
 * Bilinear sample at (x, y), treating pixel values as point samples at pixel
 * centres. Any contributing `NaN` neighbour yields `NaN`: missing data is
 * reported, never filled.
 */
export function sampleBilinear(m: Mosaic, x: number, y: number): number {
  const fx = x / m.g - 0.5 - m.i0;
  const fy = -y / m.g - 0.5 - m.j0;
  const c = Math.floor(fx);
  const r = Math.floor(fy);
  const tx = fx - c;
  const ty = fy - r;
  let sum = 0;
  for (let dr = 0; dr <= 1; dr++) {
    const wy = dr === 0 ? 1 - ty : ty;
    if (wy === 0) continue;
    for (let dc = 0; dc <= 1; dc++) {
      const wx = dc === 0 ? 1 - tx : tx;
      if (wx === 0) continue;
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= m.width || rr >= m.height) return Number.NaN;
      const v = m.data[rr * m.width + cc];
      if (Number.isNaN(v)) return Number.NaN;
      sum += wx * wy * v;
    }
  }
  return sum;
}

/** Sample every node of the output grid. */
export function sampleGrid(
  m: Mosaic,
  bbox: BBox,
  resolution: number,
): { values: Float32Array; width: number; height: number; noDataCount: number } {
  const { width, height } = gridShape(bbox, resolution);
  const values = new Float32Array(width * height);
  let noDataCount = 0;
  for (let row = 0; row < height; row++) {
    const y = bbox.maxY - row * resolution;
    for (let col = 0; col < width; col++) {
      const v = sampleBilinear(m, bbox.minX + col * resolution, y);
      if (Number.isNaN(v)) noDataCount++;
      values[row * width + col] = v;
    }
  }
  return { values, width, height, noDataCount };
}
