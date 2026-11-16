/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A synthetic `SwissGeodata` for tests: terrain from an analytic height
 * function sampled exactly at the grid nodes the real client would return
 * (origin at (minX, maxY), rows north to south), a square parcel, and an ÖREB
 * lookup that can succeed, find nothing or fail. No network.
 */

import { attributionFor, type BBox, type ElevationGrid, type OerebExtractRef, type SwissParcel } from '@ifc-lite/geodata-ch';
import type { SiteContextGeodata } from '../src/types.js';

export type HeightFn = (x: number, y: number) => number;

export const plane = (x: number, y: number): number => 500 + 0.02 * (x - 2_600_000) - 0.01 * (y - 1_200_000);
export const paraboloid = (x: number, y: number): number => 600 - ((x - 2_600_000) ** 2 + (y - 1_200_000) ** 2) / 1000;

export interface StubOptions {
  height?: HeightFn;
  /** Nodes where this returns true have no data (NaN). */
  noData?: (x: number, y: number) => boolean;
  missingTiles?: string[];
  parcel?: SwissParcel | null;
  oereb?: 'ok' | 'none' | 'fail';
}

export interface Stub extends SiteContextGeodata {
  calls: string[];
  readonly requestCount: number;
}

export function squareParcel(cx: number, cy: number, half: number, egrid = 'CH123456789012'): SwissParcel {
  const ring = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
    [cx - half, cy - half],
  ];
  return {
    id: egrid,
    egrid,
    number: '4711',
    region: 'BE',
    canton: 'BE',
    cadastralDistrict: 'BE0351',
    realEstateType: 'Liegenschaft',
    geoportalUrl: null,
    geometry: { type: 'Polygon', coordinates: [ring] },
    computedArea: (2 * half) ** 2,
    sourceLayer: 'ch.kantone.cadastralwebmap-farbe',
    properties: {},
    crs: 'EPSG:2056',
    attribution: [attributionFor('cadastre')],
  };
}

function oerebRef(egrid: string): OerebExtractRef {
  const base = 'https://oereb.example.test/oereb';
  return {
    egrid,
    canton: 'BE',
    municipality: null,
    status: null,
    serviceBase: base,
    urls: {
      json: `${base}/extract/json/?EGRID=${egrid}`,
      xml: `${base}/extract/xml/?EGRID=${egrid}`,
      pdf: `${base}/extract/pdf/?EGRID=${egrid}`,
      url: `${base}/extract/url/?EGRID=${egrid}`,
    },
    source: 'federal-register',
    tableEntry: null,
    attribution: [attributionFor('oerebAvailability')],
  };
}

export function stubGrid(bbox: BBox, resolution: number, opts: StubOptions = {}): ElevationGrid {
  const height = opts.height ?? plane;
  const width = Math.floor((bbox.maxX - bbox.minX) / resolution + 1e-9) + 1;
  const rows = Math.floor((bbox.maxY - bbox.minY) / resolution + 1e-9) + 1;
  const values = new Float32Array(width * rows);
  let noDataCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < width; c++) {
      const x = bbox.minX + c * resolution;
      const y = bbox.maxY - r * resolution;
      const v = opts.noData?.(x, y) ? NaN : height(x, y);
      if (Number.isNaN(v)) noDataCount++;
      values[r * width + c] = v;
    }
  }
  return {
    crs: 'EPSG:2056',
    verticalCrs: 'EPSG:5728',
    verticalReference: 'LN02 (stub)',
    origin: { x: bbox.minX, y: bbox.maxY },
    resolution,
    width,
    height: rows,
    values,
    noDataCount,
    hasData: noDataCount < width * rows,
    sources: [{ id: 'swissalti3d_2019_2600-1199', url: 'https://stub.test/swissalti3d_2019_2600-1199_0.5_2056_5728.tif', acquired: '2019-01-01T00:00:00Z', gsd: 0.5 }],
    missingTiles: opts.missingTiles ?? [],
    attribution: [attributionFor('swissalti3d')],
  };
}

export function stubGeodata(opts: StubOptions = {}): Stub {
  const calls: string[] = [];
  const parcel = opts.parcel === undefined ? squareParcel(2_600_010, 1_199_990, 20) : opts.parcel;
  return {
    calls,
    get requestCount() {
      return calls.length;
    },
    async elevationGrid(bbox, { resolution }) {
      calls.push(`elevationGrid ${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY} @${resolution}`);
      return stubGrid(bbox, resolution, opts);
    },
    async parcelsAtPoint(x, y) {
      calls.push(`parcelsAtPoint ${x},${y}`);
      return parcel ? [parcel] : [];
    },
    async parcelById(egrid) {
      calls.push(`parcelById ${egrid}`);
      return parcel && parcel.egrid === egrid ? parcel : null;
    },
    async oerebExtract(egrid) {
      calls.push(`oerebExtract ${egrid}`);
      if (opts.oereb === 'fail') throw new Error('stub ÖREB service unavailable');
      if (opts.oereb === 'none') return null;
      return oerebRef(egrid);
    },
  };
}
