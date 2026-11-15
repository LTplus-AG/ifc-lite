/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Item search on the swisstopo STAC API v1 (https://data.geo.admin.ch/api/stac/v1). */

import type { BBox } from './contracts.js';
import type { HttpClient } from './http.js';
import { paddedWgs84BBox } from './lv95.js';

export const STAC_BASE = 'https://data.geo.admin.ch/api/stac/v1';

export interface StacAsset {
  href: string;
  type?: string;
  gsd?: number;
  'proj:epsg'?: number;
  'geoadmin:variant'?: string;
  'file:size'?: number;
  [k: string]: unknown;
}

export interface StacItem {
  id: string;
  bbox: number[];
  properties: { datetime?: string | null; [k: string]: unknown };
  assets: Record<string, StacAsset>;
}

interface ItemCollection {
  features: StacItem[];
  links?: Array<{ rel: string; href: string }>;
}

/** Safety bound on pagination: 100 items per page, so 10 000 items. */
const MAX_PAGES = 100;

/**
 * Every item of `collection` whose WGS84 bbox intersects the LV95 box,
 * padded so the approximate projection cannot drop an edge tile. The result
 * is therefore a superset; callers filter on exact LV95 keys where they can.
 */
export async function stacItems(
  http: HttpClient,
  collection: string,
  bbox: BBox,
  options: { signal?: AbortSignal; padMetres?: number } = {},
): Promise<StacItem[]> {
  const wgs = paddedWgs84BBox(bbox, options.padMetres ?? 50).map((v) => v.toFixed(7)).join(',');
  let url: string | undefined =
    `${STAC_BASE}/collections/${encodeURIComponent(collection)}/items?bbox=${wgs}&limit=100`;
  const items: StacItem[] = [];
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`STAC search on ${collection} exceeded ${MAX_PAGES} pages; narrow the bbox`);
    const res: ItemCollection = await http.getJson<ItemCollection>(url, { signal: options.signal });
    items.push(...(res.features ?? []));
    url = res.links?.find((l) => l.rel === 'next')?.href;
  }
  return items;
}

/** The 4-digit acquisition year from an item's `datetime`, or `null`. */
export function itemYear(item: StacItem): number | null {
  const d = item.properties.datetime;
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  return Number.isInteger(y) ? y : null;
}
