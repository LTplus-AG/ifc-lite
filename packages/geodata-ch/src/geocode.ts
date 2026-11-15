/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Address and place search through api3's SearchServer, results in LV95. */

import { API3_BASE } from './api3.js';
import { attributionFor } from './attribution.js';
import type { GeocodeCandidate, GeocodeResult } from './contracts.js';
import { query, type HttpClient } from './http.js';
import { isLv95Easting, isLv95Northing, LV95 } from './lv95.js';

/** SearchServer `origins`; see https://docs.geo.admin.ch/access-data/search.html. */
export type SearchOrigin = 'address' | 'parcel' | 'zipcode' | 'gg25' | 'district' | 'kantone' | 'gazetteer';

export interface GeocodeOptions {
  /** Whole number from 1 to 50 (the service's cap), otherwise a `RangeError`. Default 5. */
  limit?: number;
  /** Default `['address']`. */
  origins?: SearchOrigin[];
  signal?: AbortSignal;
}

interface SearchResponse {
  results: Array<{
    id?: number | string;
    weight?: number;
    attrs: {
      label?: string;
      origin?: string;
      x?: number;
      y?: number;
      featureId?: string;
    };
  }>;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The service names its axes `x` and `y` and, with `sr=2056`, puts the
 * northing in `x` and the easting in `y` (checked live 2026-11-15:
 * Bundesplatz 3, Bern → x=1199521, y=2600423). Rather than trust the names,
 * assign by value range, and refuse a result that fits neither way.
 */
export function lv95FromSearchAttrs(x: number, y: number): { e: number; n: number } {
  if (isLv95Easting(y) && isLv95Northing(x)) return { e: y, n: x };
  if (isLv95Easting(x) && isLv95Northing(y)) return { e: x, n: y };
  throw new RangeError(`SearchServer returned coordinates outside LV95: x=${x}, y=${y}`);
}

export async function geocode(http: HttpClient, text: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const limit = options.limit ?? 5;
  // Clamping would turn NaN or 0 into a query the caller did not ask for; refuse instead.
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError(`limit must be an integer from 1 to 50, got ${limit}`);
  }
  const url =
    `${API3_BASE}/api/SearchServer?` +
    query({
      searchText: text,
      type: 'locations',
      origins: (options.origins ?? ['address']).join(','),
      sr: 2056,
      limit,
      // Not `returnGeometry=false`: the service then drops `x`/`y` from every result (seen live 2026-11-15).
    });
  const res = await http.getJson<SearchResponse>(url, { signal: options.signal });
  const candidates: GeocodeCandidate[] = [];
  for (const r of res.results ?? []) {
    const { x, y } = r.attrs;
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error(`SearchServer result ${JSON.stringify(r.attrs.label ?? r.id)} has no coordinates`);
    }
    const { e, n } = lv95FromSearchAttrs(x, y);
    candidates.push({
      label: stripTags(r.attrs.label ?? ''),
      x: e,
      y: n,
      crs: LV95,
      origin: r.attrs.origin ?? 'unknown',
      weight: r.weight ?? 0,
      featureId: r.attrs.featureId ?? (r.id !== undefined ? String(r.id) : null),
    });
  }
  return { candidates, crs: LV95, attribution: [attributionFor('geocoding')] };
}
