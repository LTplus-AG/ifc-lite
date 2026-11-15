/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Thin typed wrappers over the api3.geo.admin.ch REST services this package
 * uses: `identify`, `find` and `SearchServer`. Parameter semantics are from
 * https://docs.geo.admin.ch/access-data/identify-features.html and siblings.
 */

import type { BBox, Geometry, PolygonGeometry } from './contracts.js';
import { query, type HttpClient } from './http.js';

export const API3_BASE = 'https://api3.geo.admin.ch/rest/services';

/** `identify` returns at most this many features per request (per underlying table). */
export const IDENTIFY_MAX_LIMIT = 200;

export interface Api3Feature {
  type?: 'Feature';
  featureId?: number | string;
  id: number | string;
  layerBodId: string;
  layerName?: string;
  bbox?: number[];
  geometry?: Geometry | null;
  /** Present with `geometryFormat=geojson`. */
  properties?: Record<string, unknown>;
  /** Present without `geometryFormat=geojson`. */
  attributes?: Record<string, unknown>;
}

interface Api3Results {
  results: Api3Feature[];
}

export type IdentifyGeometry =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'envelope'; bbox: BBox }
  | { kind: 'polygon'; polygon: PolygonGeometry };

export interface IdentifyParams {
  layer: string;
  geometry: IdentifyGeometry;
  returnGeometry?: boolean;
  limit?: number;
  signal?: AbortSignal;
  /** Forwarded to `HttpClient.get`: called once per network send. */
  onSend?: () => void;
}

function encodeGeometry(g: IdentifyGeometry): { geometryType: string; geometry: string } {
  switch (g.kind) {
    case 'point':
      return { geometryType: 'esriGeometryPoint', geometry: `${g.x},${g.y}` };
    case 'envelope':
      return {
        geometryType: 'esriGeometryEnvelope',
        geometry: `${g.bbox.minX},${g.bbox.minY},${g.bbox.maxX},${g.bbox.maxY}`,
      };
    case 'polygon':
      return {
        geometryType: 'esriGeometryPolygon',
        geometry: JSON.stringify({
          rings: g.polygon.coordinates.map((r) => r.map((p) => [p[0], p[1]])),
          spatialReference: { wkid: 2056 },
        }),
      };
  }
}

/**
 * The GET URL `identify` sends. Exposed so callers can measure it: a polygon
 * travels as JSON in the query string, so many vertices make a long URL.
 */
export function identifyUrl(p: IdentifyParams): string {
  return (
    `${API3_BASE}/all/MapServer/identify?` +
    query({
      ...encodeGeometry(p.geometry),
      layers: `all:${p.layer}`,
      tolerance: 0,
      returnGeometry: p.returnGeometry ?? true,
      geometryFormat: 'geojson',
      sr: 2056,
      limit: p.limit ?? IDENTIFY_MAX_LIMIT,
    })
  );
}

/**
 * Features of one layer intersecting a geometry (tolerance 0, LV95, GeoJSON).
 *
 * `mapExtent` and `imageDisplay` are deliberately omitted: with them the
 * server applies the layer's scale-dependent filtering. On 2026-11-15 the
 * same polygon over Bern returned 32 roads with a 2 km map extent and 95
 * without one.
 */
export async function identify(http: HttpClient, p: IdentifyParams): Promise<Api3Feature[]> {
  const res = await http.getJson<Api3Results>(identifyUrl(p), { signal: p.signal, onSend: p.onSend });
  return res.results ?? [];
}

/** Exact attribute match on one layer (`find` with `contains=false`). */
export async function findExact(
  http: HttpClient,
  p: { layer: string; field: string; value: string; returnGeometry?: boolean; signal?: AbortSignal },
): Promise<Api3Feature[]> {
  const url =
    `${API3_BASE}/all/MapServer/find?` +
    query({
      layer: p.layer,
      searchField: p.field,
      searchText: p.value,
      contains: false,
      returnGeometry: p.returnGeometry ?? true,
      geometryFormat: 'geojson',
      sr: 2056,
    });
  const res = await http.getJson<Api3Results>(url, { signal: p.signal });
  return res.results ?? [];
}

/** Attributes of a feature regardless of `geometryFormat`. */
export function featureProps(f: Api3Feature): Record<string, unknown> {
  return f.properties ?? f.attributes ?? {};
}

export function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}
