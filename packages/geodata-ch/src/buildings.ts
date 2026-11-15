/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * swissBUILDINGS3D 3.0 tile discovery from the STAC collection
 * `ch.swisstopo.swissbuildings3d_3_0`.
 *
 * Checked live on 2026-11-15: tiled items are named
 * `swissbuildings3d_3_0_<year>_<map sheet>` (e.g. `1166-42`, a subdivision
 * of the 1:25 000 sheet, not a km grid); the formats offered are
 * `citygml.zip`, `dwg.zip` and `gdb.zip` (not every year has every format);
 * nationwide `fullcoverage` items hold one large FileGDB. No light format
 * (glTF, 3D Tiles, CityJSON) is offered, so parsing stays a follow-up.
 * The assets state no byte size, so size comes from a one-byte range read.
 */

import { attributionFor } from './attribution.js';
import type { BBox, BuildingAsset, BuildingTileResult } from './contracts.js';
import type { HttpClient } from './http.js';
import { approxLv95FromWgs84BBox, assertLv95BBox, bboxIntersects, LN02, LV95 } from './lv95.js';
import { itemYear, stacItems, type StacAsset } from './stac.js';

export const SWISSBUILDINGS3D_COLLECTION = 'ch.swisstopo.swissbuildings3d_3_0';

const ITEM_ID = /^swissbuildings3d_3_0_(\d{4})_(.+)$/;

export interface BuildingTileOptions {
  /** File formats wanted, by the extension before `.zip`. Default `['citygml']`. */
  formats?: string[];
  /** Read each asset's size with a one-byte range request. Default true. */
  resolveSize?: boolean;
  signal?: AbortSignal;
}

/** `swissbuildings3d_3_0_2021_1166-42_2056_5728.citygml.zip` → `citygml`. */
export function assetFormat(href: string): string | null {
  const m = /\.([a-z0-9]+)\.zip$/i.exec(href);
  return m ? m[1].toLowerCase() : null;
}

function sizeFromContentRange(v: string | undefined): number | null {
  const m = v ? /\/(\d+)\s*$/.exec(v) : null;
  return m ? Number(m[1]) : null;
}

export async function buildingTiles(
  http: HttpClient,
  bbox: BBox,
  options: BuildingTileOptions = {},
): Promise<BuildingTileResult> {
  assertLv95BBox(bbox);
  const formats = new Set((options.formats ?? ['citygml']).map((f) => f.toLowerCase()));
  const items = await stacItems(http, SWISSBUILDINGS3D_COLLECTION, bbox, { signal: options.signal });

  // Newest year per (sheet, format), tiled variant only.
  const best = new Map<string, { year: number; asset: BuildingAsset }>();
  for (const item of items) {
    const m = ITEM_ID.exec(item.id);
    if (!m) continue;
    const extent = approxLv95FromWgs84BBox(item.bbox);
    if (!bboxIntersects(extent, { minX: bbox.minX - 5, minY: bbox.minY - 5, maxX: bbox.maxX + 5, maxY: bbox.maxY + 5 })) {
      continue;
    }
    const year = itemYear(item) ?? Number(m[1]);
    for (const a of Object.values(item.assets) as StacAsset[]) {
      if (a['geoadmin:variant'] !== 'tiled') continue;
      const format = assetFormat(a.href);
      if (!format || !formats.has(format)) continue;
      const key = `${m[2]}|${format}`;
      const prev = best.get(key);
      if (prev && prev.year >= year) continue;
      best.set(key, {
        year,
        asset: {
          tileId: m[2],
          url: a.href,
          format,
          mediaType: a.type ?? 'application/octet-stream',
          size: typeof a['file:size'] === 'number' ? a['file:size'] : null,
          extent,
          extentApproximate: true,
          acquired: item.properties.datetime ?? null,
          crs: LV95,
          verticalCrs: a.href.includes('_2056_5728') ? LN02 : null,
        },
      });
    }
  }

  const assets = [...best.values()].map((b) => b.asset).sort((a, b) => a.url.localeCompare(b.url));
  if (options.resolveSize ?? true) {
    for (const a of assets) {
      if (a.size !== null) continue;
      const res = await http.get(a.url, { headers: { Range: 'bytes=0-0' }, signal: options.signal });
      a.size = sizeFromContentRange(res.headers['content-range']);
    }
  }
  return { assets, crs: LV95, attribution: [attributionFor('swissbuildings3d')] };
}
