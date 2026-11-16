/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * From a swissBUILDINGS3D tile feature to the site frame.
 *
 * The conversion chain, per vertex:
 *   1. ECEF (WGS84, metres, f64, as the reader returns it) to geodetic
 *      longitude, latitude and height with `ecefToGeodetic`;
 *   2. longitude and latitude to EPSG:2056 easting and northing with
 *      `@ifc-lite/geo` (`fromWgs84`; its datum shift for EPSG:2056 is the
 *      exactly defined CHTRS95 → CH1903+ translation, no grid);
 *   3. the geodetic height is taken as the LN02 (EPSG:5728) height, as stored.
 *
 * Step 3 rests on an observed property of the dataset, not on 3D Tiles: the
 * tiles store Swiss national heights in the slot 3D Tiles reserves for
 * ellipsoidal height (release 20260520: building tops equal their `DACH_MAX`
 * attribute to 0.01 m, tile centres sit at ellipsoidal height 0, where a
 * true ellipsoidal height would be about 50 m higher). No geoid correction
 * is applied. `heightCheck` guards it: a top that disagrees with `DACH_MAX`
 * means the dataset changed, and the layer says so.
 */

import { resolveCrs, type CrsTransformer } from '@ifc-lite/geo';
import { ecefToGeodetic, type GeoRegion } from '@ifc-lite/tiles3d';
import type { MapPoint } from './types.js';

/** A building top may differ from its `DACH_MAX` by this much (metres) before the height assumption is reported broken. */
export const HEIGHT_CHECK_TOLERANCE = 0.05;

let lv95: Promise<CrsTransformer> | null = null;

export function lv95Transformer(): Promise<CrsTransformer> {
  lv95 ??= resolveCrs({ epsg: 2056 }).then((t) => {
    if (!t) throw new Error('@ifc-lite/geo could not resolve EPSG:2056');
    return t;
  });
  return lv95;
}

/**
 * ECEF xyz triplets to EPSG:2056 / LN02 xyz triplets (f64). `null` when a
 * vertex does not map. Each distinct position is converted once (the tiles
 * repeat a vertex for every triangle and primitive that uses it, about
 * twelve times per building), keyed by its exact coordinates, so the result
 * is the same as converting every vertex.
 */
export function ecefToLv95(ecef: Float64Array, t: CrsTransformer): Float64Array | null {
  const out = new Float64Array(ecef.length);
  const seen = new Map<string, number>();
  for (let i = 0; i < ecef.length; i += 3) {
    const key = `${ecef[i]},${ecef[i + 1]},${ecef[i + 2]}`;
    const first = seen.get(key);
    if (first !== undefined) {
      out[i] = out[first];
      out[i + 1] = out[first + 1];
      out[i + 2] = out[first + 2];
      continue;
    }
    const g = ecefToGeodetic(ecef[i], ecef[i + 1], ecef[i + 2]);
    const p = t.fromWgs84([g.lon, g.lat]);
    if (!p) return null;
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = g.height;
    seen.set(key, i);
  }
  return out;
}

/** The WGS84 box that holds the EPSG:2056 square, padded by about 0.1 m. */
export function siteRegion(box: { minX: number; minY: number; maxX: number; maxY: number }, t: CrsTransformer): GeoRegion {
  const corners: MapPoint[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const c of corners) {
    const g = t.toWgs84([c.x, c.y]);
    if (!g) throw new RangeError(`site corner (${c.x}, ${c.y}) does not map to WGS84`);
    west = Math.min(west, g[0]);
    east = Math.max(east, g[0]);
    south = Math.min(south, g[1]);
    north = Math.max(north, g[1]);
  }
  const pad = 1e-6;
  return { west: west - pad, south: south - pad, east: east + pad, north: north + pad };
}

/** Roof when the material's base colour is red-dominant (swisstopo: roof red 0.81/0.25/0.25, walls beige 0.89/0.85/0.56). */
export function isRoofColour(rgba: readonly number[] | undefined): boolean | null {
  if (!rgba) return null;
  const [r, g, b] = rgba;
  return r - Math.max(g, b) > 0.3;
}

export function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** EGID as a string; `null` when absent or blank (the producer writes whitespace for empty text columns). */
export function textOrNull(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}
