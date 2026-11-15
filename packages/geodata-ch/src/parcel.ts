/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parcels from the cantonal cadastral web map layer on api3
 * (`ch.kantone.cadastralwebmap-farbe`), by EGRID or by point, in LV95.
 *
 * The federal `ch.swisstopo-vd.geometa-grundstueck` layer that
 * swiss-zoning-api used is gone: api3 answered "No GeoTable was found" for
 * it on 2026-11-15.
 */

import { featureProps, findExact, identify, str, type Api3Feature } from './api3.js';
import { attributionFor } from './attribution.js';
import type { MultiPolygonGeometry, Parcel, PolygonGeometry } from './contracts.js';
import type { HttpClient } from './http.js';
import { assertLv95Point, LV95, polygonArea } from './lv95.js';

export const PARCEL_LAYER = 'ch.kantone.cadastralwebmap-farbe';

/** Swiss EGRID: `CH` followed by 12 digits/letters (eCH-0129). */
const EGRID_RE = /^CH[0-9A-Z]{12}$/;

export function isEgrid(s: string): boolean {
  return EGRID_RE.test(s);
}

/** The Swiss parcel, with the provider-neutral fields plus Swiss names. */
export interface SwissParcel extends Parcel {
  egrid: string;
  /** Two-letter canton code (`ak`). */
  canton: string | null;
  /** Cantonal identifier of the cadastral district (`identnd`). */
  cadastralDistrict: string | null;
  realEstateType: string | null;
  geoportalUrl: string | null;
}

function toParcel(f: Api3Feature): SwissParcel | null {
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null;
  const geometry = g as PolygonGeometry | MultiPolygonGeometry;
  const p = featureProps(f);
  const egrid = str(p.egris_egrid);
  if (!egrid) return null;
  return {
    id: egrid,
    egrid,
    number: str(p.number),
    region: str(p.ak),
    canton: str(p.ak),
    cadastralDistrict: str(p.identnd),
    realEstateType: str(p.realestate_type),
    geoportalUrl: str(p.geoportal_url),
    geometry,
    computedArea: polygonArea(geometry),
    sourceLayer: f.layerBodId,
    properties: p,
    crs: LV95,
    attribution: [attributionFor('cadastre')],
  };
}

export async function parcelByEgrid(
  http: HttpClient,
  egrid: string,
  options: { signal?: AbortSignal } = {},
): Promise<SwissParcel | null> {
  const id = egrid.trim().toUpperCase();
  if (!isEgrid(id)) throw new RangeError(`not an EGRID: ${JSON.stringify(egrid)}`);
  const hits = await findExact(http, {
    layer: PARCEL_LAYER,
    field: 'egris_egrid',
    value: id,
    signal: options.signal,
  });
  const parcels = hits.map(toParcel).filter((p): p is SwissParcel => p !== null && p.egrid === id);
  if (parcels.length > 1) {
    throw new Error(`EGRID ${id} matched ${parcels.length} parcel geometries; refusing to pick one`);
  }
  return parcels[0] ?? null;
}

export async function parcelsAtPoint(
  http: HttpClient,
  x: number,
  y: number,
  options: { signal?: AbortSignal } = {},
): Promise<SwissParcel[]> {
  assertLv95Point(x, y);
  const hits = await identify(http, {
    layer: PARCEL_LAYER,
    geometry: { kind: 'point', x, y },
    signal: options.signal,
  });
  return hits.map(toParcel).filter((p): p is SwissParcel => p !== null);
}
