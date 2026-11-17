/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared test helpers: fixtures, a tiny PNG encoder, synthetic rasters and facts. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zlibSync } from 'fflate';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import type { CandidateFact, ModelFacts } from '../src/model/facts.js';
import {
  CELL_NO_RUNOFF,
  type ClassifiedHazardRaster,
  type OtherBuildingFootprints,
  type HazardProvenance,
  type MapPoint,
  type TerrainSampler,
} from '../src/types.js';

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/bafu/${name}`, import.meta.url))));
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface EncodeOptions {
  colourType: 0 | 2 | 3 | 4 | 6;
  bitDepth?: number;
  palette?: number[][];
  trns?: number[];
  interlace?: boolean;
  /** Row filter per row (cycled). Default all 0. */
  filters?: number[];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode raw scanline bytes (already packed per colour type / depth) as a PNG, applying the given filters. */
export function encodePng(width: number, height: number, rows: Uint8Array[], o: EncodeOptions): Uint8Array {
  const depth = o.bitDepth ?? 8;
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colourType] * depth) / 8);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = o.colourType;
  ihdr[12] = o.interlace ? 1 : 0;
  const stride = rows[0].length;
  const raw = new Uint8Array((stride + 1) * height);
  let prev: Uint8Array = new Uint8Array(stride);
  rows.forEach((row, y) => {
    const f = o.filters ? o.filters[y % o.filters.length] : 0;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (row[x] - pred) & 0xff;
    }
    prev = row;
  });
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (o.palette) parts.push(chunk('PLTE', new Uint8Array(o.palette.flat())));
  if (o.trns) parts.push(chunk('tRNS', new Uint8Array(o.trns)));
  parts.push(chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An RGBA8 PNG from a per-pixel colour function. */
export function rgbaPng(width: number, height: number, colour: (x: number, y: number) => number[]): Uint8Array {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) row.set(colour(x, y), x * 4);
    rows.push(row);
  }
  return encodePng(width, height, rows, { colourType: 6, filters: [0, 1, 2, 3, 4] });
}

export const PROVENANCE: HazardProvenance = {
  providerId: 'test',
  datasetId: 'test-layer',
  datasetTitle: { de: 'Test', en: 'Test' },
  datasetDate: '2018-05-22',
  retrievedAt: '2026-11-15T10:00:00.000Z',
  requestUrl: 'https://example.invalid/wms',
  attribution: 'test attribution',
  licence: 'test licence',
  returnPeriod: { de: 'Wiederkehr', en: 'return' },
  limits: [{ de: 'Grenze', en: 'limit' }],
  disclaimer: { de: 'Hinweis', en: 'note' },
};

export const CODE = Object.fromEntries(BAFU_CLASSES.map((c, i) => [c.id, i + 1])) as Record<string, number>;

/**
 * A synthetic BAFU-classed raster over `[x0, x0+w*cell] x [y0, y0+h*cell]`,
 * cells set by `paint(centre)` (a cell code; default no runoff).
 */
export function syntheticRaster(
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  paint: (p: MapPoint) => number = () => CELL_NO_RUNOFF,
  crs = 'EPSG:2056',
  /** Synthetic rasters state their coverage explicitly; the default says the whole raster lies within the mapped area. */
  covers: ClassifiedHazardRaster['covers'] = 'everywhere',
): ClassifiedHazardRaster {
  const cells = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      cells[row * w + col] = paint({ x: x0 + (col + 0.5) * cell, y: y0 + h * cell - (row + 0.5) * cell });
    }
  }
  return {
    crs,
    width: w,
    height: h,
    cellSize: cell,
    origin: { x: x0, y: y0 + h * cell },
    cells,
    classes: BAFU_CLASSES,
    counts: { total: w * h, classified: 0, noRunoff: 0, unclassifiedOpaque: 0, unclassifiedTranslucent: 0, byClass: {} },
    provenance: PROVENANCE,
    covers,
  };
}

/** swissALTI3D's stated 1-sigma accuracy for new LiDAR, used as the default stated accuracy in tests. */
export const TEST_ACCURACY = 0.3;
/** The margin that accuracy yields with the default georeferencing term: max(0.5, 2 * sqrt(0.3^2 + 0.25^2 + 0.5^2)). */
export const TEST_MARGIN = 2 * Math.sqrt(0.3 ** 2 + 0.25 ** 2 + 0.5 ** 2);

export function flatTerrain(
  height: number,
  verticalCrs = 'EPSG:5728',
  crs = 'EPSG:2056',
  verticalAccuracy: number | null = TEST_ACCURACY,
): TerrainSampler {
  return { crs, verticalCrs, verticalAccuracy: verticalAccuracy ?? undefined, heightAt: () => height };
}

/** A sampler from a height function, with the test accuracy. */
export function terrainFn(heightAt: (p: MapPoint) => number | null, verticalAccuracy: number | null = TEST_ACCURACY): TerrainSampler {
  return { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalAccuracy: verticalAccuracy ?? undefined, heightAt };
}

/** The rendering confirmation a provider would give for a layer that renders. */
export const CONFIRMED = { confirmed: true, requestUrl: 'https://example.invalid/reference', detail: 'test', retrievedAt: PROVENANCE.retrievedAt } as const;

/** A 20 m x 10 m box building at (E0, N0)-(E0+20, N0+10), ground storey at `ground`. */
export const E0 = 2_600_000;
export const N0 = 1_200_000;

export function candidate(over: Partial<CandidateFact> & Pick<CandidateFact, 'position' | 'level'>): CandidateFact {
  return {
    expressId: 1,
    globalId: 'g1',
    name: 'Door',
    ifcClass: 'IfcDoor',
    predefinedType: 'DOOR',
    category: 'door',
    levelBasis: 'placement-origin',
    levelIsUpperEstimate: false,
    storeyId: 10,
    selectedBecause: 'test',
    ...over,
  };
}

export function boxFacts(candidates: CandidateFact[], over: Partial<ModelFacts> = {}): ModelFacts {
  return {
    georeference: {
      crs: 'EPSG:2056',
      verticalDatum: null,
      source: 'mapConversion',
      eastings: E0,
      northings: N0,
      orthogonalHeight: 500,
      rotationDegrees: 0,
      horizontalScale: 1,
      scaleBasis: 'units-agree',
      lengthUnitScale: 1,
    },
    footprint: {
      rings: [[{ x: E0, y: N0 }, { x: E0 + 20, y: N0 }, { x: E0 + 20, y: N0 + 10 }, { x: E0, y: N0 + 10 }]],
      source: 'given',
      fromElements: [],
    },
    storeys: [
      { expressId: 9, globalId: 's9', name: 'UG', level: 497 },
      { expressId: 10, globalId: 's10', name: 'EG', level: 500 },
    ],
    groundStorey: { expressId: 10, level: 500, basis: 'given' },
    candidates,
    spaces: [],
    skipped: [],
    warnings: [],
    ...over,
  };
}

/**
 * A complete source stating there are no other buildings near the test
 * building: transparent samples are then open ground (`CheckOptions.otherBuildings`).
 */
export const NO_OTHER_BUILDINGS: OtherBuildingFootprints = { crs: 'EPSG:2056', rings: [], complete: true, extent: { minX: E0 - 5000, minY: N0 - 5000, maxX: E0 + 5000, maxY: N0 + 5000 }, provenance: { source: 'test: no other buildings' } };
