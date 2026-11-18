/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test support for the buildings layer: an offline fetch over the recorded
 * swisstopo tiles that `@ifc-lite/tiles3d` keeps in `packages/tiles3d/fixtures`
 * (release 20260520, © swisstopo; see the README there), an independent
 * WGS84 → LV95 conversion, and a synthetic reader for exact shapes. No network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geodeticToEcef, type FetchLike, type FetchResponseLike, type SwisstopoBuildingsResult, type SwissBuildingFeature } from '@ifc-lite/tiles3d';
import type { BuildingsReader } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tiles3d', 'fixtures');
const BASE = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/';

/** Leaf 11/668/1170 (Bern, 4 buildings with EGID) spans about 168 × 108 m around this LV95 point. */
export const BERN_LEAF_CENTRE = { x: 2_600_029, y: 1_200_053 };
/** Leaf 11/83/393 (Geneva, 9 buildings, no EGID or height columns). */
export const GENEVA_LEAF_POINT = { lon: 6.14425, lat: 46.1989 };

function response(bytes: Uint8Array | undefined): FetchResponseLike {
  if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer };
}

/** Serves the recorded tiles; anything the recording trimmed away answers 404. */
export function fixtureFetch(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    if (!url.startsWith(BASE)) return response(undefined);
    const rel = url.slice(BASE.length);
    const file = join(FIXTURES, rel === 'tileset.json' ? 'swisstopo-root-tileset.json' : rel.replace(/^20260520\//, 'swisstopo-20260520/'));
    return response(existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined);
  };
  return Object.assign(f, { urls });
}

/**
 * WGS84 → LV95 written out from swisstopo's rigorous formulas, sharing no
 * code with `@ifc-lite/geo`: geodetic → ECEF on WGS84, the defined
 * CHTRS95 → CH1903+ translation, ECEF → Bessel geodetic, then the Swiss
 * oblique Mercator projection (sphere, rotation, Mercator).
 */
export function wgs84ToLv95(lonDeg: number, latDeg: number, h = 0): { x: number; y: number } {
  const rad = Math.PI / 180;
  const aW = 6378137, fW = 1 / 298.257223563, e2W = fW * (2 - fW);
  const lat = latDeg * rad, lon = lonDeg * rad;
  const nW = aW / Math.sqrt(1 - e2W * Math.sin(lat) ** 2);
  const X = (nW + h) * Math.cos(lat) * Math.cos(lon) - 674.374;
  const Y = (nW + h) * Math.cos(lat) * Math.sin(lon) - 15.056;
  const Z = (nW * (1 - e2W) + h) * Math.sin(lat) - 405.346;
  const a = 6377397.155, e2 = 0.006674372230614, e = Math.sqrt(e2);
  const p = Math.hypot(X, Y);
  let phi = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(Z + e2 * n * Math.sin(phi), p);
  }
  const lambda = Math.atan2(Y, X);
  const phi0 = (46 + 57 / 60 + 8.66 / 3600) * rad, lambda0 = (7 + 26 / 60 + 22.5 / 3600) * rad;
  const R = (a * Math.sqrt(1 - e2)) / (1 - e2 * Math.sin(phi0) ** 2);
  const alpha = Math.sqrt(1 + (e2 / (1 - e2)) * Math.cos(phi0) ** 4);
  const b0 = Math.asin(Math.sin(phi0) / alpha);
  const iso = (q: number) => Math.log(Math.tan(Math.PI / 4 + q / 2)) - (e / 2) * Math.log((1 + e * Math.sin(q)) / (1 - e * Math.sin(q)));
  const K = Math.log(Math.tan(Math.PI / 4 + b0 / 2)) - alpha * iso(phi0);
  const S = alpha * iso(phi) + K;
  const b = 2 * (Math.atan(Math.exp(S)) - Math.PI / 4);
  const l = alpha * (lambda - lambda0);
  const lBar = Math.atan(Math.sin(l) / (Math.sin(b0) * Math.tan(b) + Math.cos(b0) * Math.cos(l)));
  const bBar = Math.asin(Math.cos(b0) * Math.sin(b) - Math.sin(b0) * Math.cos(b) * Math.cos(l));
  return { x: 2_600_000 + R * lBar, y: 1_200_000 + (R / 2) * Math.log((1 + Math.sin(bBar)) / (1 - Math.sin(bBar))) };
}

/** LV95 → WGS84 lon/lat by Newton iteration on `wgs84ToLv95` (only for building synthetic tiles). */
export function lv95ToWgs84(x: number, y: number): { lon: number; lat: number } {
  let lon = 7.4386 + (x - 2_600_000) / 76_000, lat = 46.9524 + (y - 1_200_000) / 111_200;
  for (let i = 0; i < 8; i++) {
    const p = wgs84ToLv95(lon, lat);
    lon -= (p.x - x) / 76_000;
    lat -= (p.y - y) / 111_200;
  }
  return { lon, lat };
}

export interface BoxSpec {
  /** LV95 corners of the base, any order around the ring. */
  ring: Array<[number, number]>;
  base: number;
  top: number;
  attributes?: Record<string, unknown>;
}

/**
 * A prism building as the swisstopo tiles encode one: ECEF float64 positions,
 * walls in the beige group, the flat roof in the red group, and every second
 * triangle wound the wrong way.
 */
export function prismFeature(spec: BoxSpec, featureId = 0): SwissBuildingFeature {
  const verts: number[] = [];
  const add = (x: number, y: number, z: number) => {
    const g = lv95ToWgs84(x, y);
    verts.push(...geodeticToEcef(g.lon, g.lat, z));
    return verts.length / 3 - 1;
  };
  const roof: number[] = [], walls: number[] = [];
  const n = spec.ring.length;
  const lo = spec.ring.map(([x, y]) => add(x, y, spec.base));
  const hi = spec.ring.map(([x, y]) => add(x, y, spec.top));
  let flip = false;
  const tri = (list: number[], a: number, b: number, c: number) => {
    list.push(...(flip ? [a, c, b] : [a, b, c]));
    flip = !flip;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(walls, lo[i], lo[j], hi[j]);
    tri(walls, lo[i], hi[j], hi[i]);
  }
  for (let i = 1; i < n - 1; i++) {
    tri(roof, hi[0], hi[i], hi[i + 1]);
    tri(walls, lo[0], lo[i + 1], lo[i]); // the base, in the wall material as in the tiles
  }
  const indices = new Uint32Array([...walls, ...roof]);
  return {
    featureId,
    positions: new Float64Array(verts),
    indices,
    groups: [
      { start: 0, count: walls.length, node: 0, mesh: 0, primitive: 0, material: 0, baseColorFactor: [0.89, 0.85, 0.56, 1] },
      { start: walls.length, count: roof.length, node: 0, mesh: 0, primitive: 1, material: 1, baseColorFactor: [0.81, 0.25, 0.25, 1] },
    ],
    attributes: spec.attributes ?? {},
    tile: { url: `${BASE}20260520/synthetic.b3dm`, tilesetUrl: `${BASE}20260520/tileset.json`, tilesetChain: [`${BASE}tileset.json`, `${BASE}20260520/tileset.json`], assetVersion: '1.0' },
  };
}

/** A reader that returns the given features as one complete read. */
export function stubReader(features: SwissBuildingFeature[], extra: Partial<SwisstopoBuildingsResult> = {}): BuildingsReader & { calls: number } {
  const r = async () => {
    r.calls++;
    return {
      features,
      tiles: [],
      issues: [],
      truncated: false,
      complete: true,
      stats: { requests: 3, bytes: 1234, cacheHits: 0, nodesVisited: 1, tilesetsLoaded: 1, contentsSelected: 1, featuresOutsideRegion: 0, decodedVertices: 0, decodedIndices: 0 },
      attribution: '© swisstopo (swissBUILDINGS3D)',
      ...extra,
    } satisfies SwisstopoBuildingsResult;
  };
  r.calls = 0;
  return r as BuildingsReader & { calls: number };
}
