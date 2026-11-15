/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * swissALTI3D elevation grids read straight from the Cloud Optimized GeoTIFF
 * tiles in the STAC collection `ch.swisstopo.swissalti3d`, by HTTP range
 * request, replacing ifc-site's thousands of per-point `height` calls.
 *
 * Facts this relies on, checked against the live collection on 2026-11-15:
 * - 1 km × 1 km tiles, item id `swissalti3d_<year>_<E km>-<N km>` with the
 *   lower-left corner in km; several acquisition years per tile.
 * - Assets at 0.5 m and 2 m GSD, `profile=cloud-optimized`, Float32, 128 px
 *   internal tiles, NoData −9999, PixelIsArea, EPSG:2056, internal overviews
 *   (0.5 m: 1, 2, 4 m; 2 m: 4 m).
 * - Heights are LN02 (EPSG:5728): swisstopo's product page states the
 *   coordinate system as "LV95 LN02" and every asset name ends `_2056_5728`.
 */

import { attributionFor } from './attribution.js';
import type { BBox, ElevationGrid } from './contracts.js';
import type { CachedResponse, HttpClient } from './http.js';
import { assertLv95BBox, bboxIntersects, LN02, LV95 } from './lv95.js';
import { stacItems, type StacItem } from './stac.js';
import { blit, createMosaic, gridShape, mosaicBBox, sampleGrid, tileWindow } from './terrain-mosaic.js';

export const SWISSALTI3D_COLLECTION = 'ch.swisstopo.swissalti3d';
export const SWISSALTI3D_VERTICAL_REFERENCE =
  'LN02 (Swiss levelling network 1902, EPSG:5728), as stated on swisstopo\'s swissALTI3D product page ("LV95 LN02")';

const ITEM_ID = /^swissalti3d_(\d{4})_(\d{4})-(\d{4})$/;

export interface TerrainOptions {
  /** Output node spacing in metres. */
  resolution: number;
  /**
   * Use this acquisition year for every tile. Default: the newest year
   * available per tile, which can differ between tiles.
   */
  year?: number;
  /** Refuse to read more source pixels than this. Default 2^26 (256 MiB of Float32). */
  maxSourcePixels?: number;
  /** Refuse to produce more nodes than this. Default 25 000 000. */
  maxNodes?: number;
  signal?: AbortSignal;
}

interface Tile {
  key: string;
  bbox: BBox;
  item: StacItem;
}

function tileFromItem(item: StacItem): { key: string; year: number; bbox: BBox } | null {
  const m = ITEM_ID.exec(item.id);
  if (!m) return null;
  const e = Number(m[2]) * 1000;
  const n = Number(m[3]) * 1000;
  return { key: `${m[2]}-${m[3]}`, year: Number(m[1]), bbox: { minX: e, minY: n, maxX: e + 1000, maxY: n + 1000 } };
}

/** The tiles a box needs, the chosen item per tile (newest, or `year`), and which are missing. */
export function selectTiles(
  items: StacItem[],
  needed: BBox,
  year?: number,
): { tiles: Tile[]; missing: string[] } {
  const best = new Map<string, { year: number; tile: Tile }>();
  for (const item of items) {
    const t = tileFromItem(item);
    if (!t || !bboxIntersects(t.bbox, needed)) continue;
    if (year !== undefined && t.year !== year) continue;
    const prev = best.get(t.key);
    if (!prev || t.year > prev.year) best.set(t.key, { year: t.year, tile: { key: t.key, bbox: t.bbox, item } });
  }
  const missing: string[] = [];
  for (let e = Math.floor(needed.minX / 1000); e * 1000 < needed.maxX; e++) {
    for (let n = Math.floor(needed.minY / 1000); n * 1000 < needed.maxY; n++) {
      const key = `${e}-${n}`;
      if (!best.has(key)) missing.push(key);
    }
  }
  return { tiles: [...best.values()].map((b) => b.tile), missing };
}

function cogAsset(item: StacItem, gsd: number): string | null {
  for (const a of Object.values(item.assets)) {
    if (a.gsd === gsd && typeof a.type === 'string' && a.type.includes('profile=cloud-optimized')) return a.href;
  }
  return null;
}

type GeoTiffModule = typeof import('geotiff');
type GeoTIFF = Awaited<ReturnType<GeoTiffModule['fromCustomClient']>>;
type GeoTIFFImage = Awaited<ReturnType<GeoTIFF['getImage']>>;

/** Open a COG through the package's HTTP client, so range reads share its rate limit, retries and cache. */
async function openCog(gt: GeoTiffModule, http: HttpClient, url: string, signal?: AbortSignal): Promise<GeoTIFF> {
  class Response extends gt.BaseResponse {
    constructor(private readonly r: CachedResponse) {
      super();
    }
    override get status(): number {
      return this.r.status;
    }
    override getHeader(name: string): string | undefined {
      return this.r.headers[name.toLowerCase()];
    }
    override async getData(): Promise<ArrayBuffer> {
      return this.r.body;
    }
  }
  class Client extends gt.BaseClient {
    override async request(init: RequestInit = {}): Promise<Response> {
      const headers = (init.headers ?? {}) as Record<string, string>;
      return new Response(await http.get(this.url, { headers, signal: init.signal ?? signal }));
    }
  }
  // 64 KiB blocks: the header and a few internal tiles per request instead of
  // geotiff's default 1 KiB header probes.
  // geotiff's implementation forwards block options here; its d.ts types only the remote half.
  const sourceOptions: import('geotiff').RemoteSourceOptions & import('geotiff').BlockedSourceOptions = {
    blockSize: 65536,
  };
  return gt.fromCustomClient(new Client(url), sourceOptions, signal);
}

async function imageAtResolution(tiff: GeoTIFF, g: number): Promise<GeoTIFFImage | null> {
  const n = await tiff.getImageCount();
  for (let i = 0; i < n; i++) {
    const img = await tiff.getImage(i);
    if (Math.abs(await resolutionOf(tiff, img, i) - g) < 1e-9) return img;
  }
  return null;
}

/** Pixel size of image `i`; overviews carry no geotransform, so derive it from the full image. */
async function resolutionOf(tiff: GeoTIFF, img: GeoTIFFImage, i: number): Promise<number> {
  if (i === 0) return img.getResolution()[0];
  return img.getResolution(await tiff.getImage(0))[0];
}

/** Coarsest pixel size the tile offers that is not coarser than `resolution`. */
async function pickLevel(tiff: GeoTIFF, resolution: number): Promise<number> {
  const n = await tiff.getImageCount();
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const g = await resolutionOf(tiff, await tiff.getImage(i), i);
    // Only levels that divide the 1 km tile exactly keep tiles on one grid.
    if (Math.abs(1000 / g - Math.round(1000 / g)) > 1e-9) continue;
    if (g <= resolution + 1e-9 && g > best) best = g;
  }
  if (!Number.isFinite(best)) {
    best = (await tiff.getImage(0)).getResolution()[0];
  }
  return best;
}

export async function elevationGrid(http: HttpClient, bbox: BBox, options: TerrainOptions): Promise<ElevationGrid> {
  assertLv95BBox(bbox);
  const { resolution, signal } = options;
  if (!(resolution > 0) || !Number.isFinite(resolution)) throw new RangeError('resolution must be a positive number');
  const shape = gridShape(bbox, resolution);
  const maxNodes = options.maxNodes ?? 25_000_000;
  if (!(maxNodes >= 0)) throw new RangeError(`maxNodes must be a number >= 0, got ${maxNodes}`);
  const maxSourcePixels = options.maxSourcePixels ?? 2 ** 26;
  if (!(maxSourcePixels >= 0)) throw new RangeError(`maxSourcePixels must be a number >= 0, got ${maxSourcePixels}`);
  if (shape.width * shape.height > maxNodes) {
    throw new RangeError(`${shape.width}×${shape.height} nodes exceeds maxNodes ${maxNodes}; use a coarser resolution`);
  }

  // The 2 m product with its 4 m overview serves anything ≥ 2 m; finer requests read the 0.5 m product.
  const gsd = resolution >= 2 ? 2 : 0.5;
  const items = await stacItems(http, SWISSALTI3D_COLLECTION, bbox, { signal });
  // One extra source pixel of margin on each side for bilinear support.
  const needed = { minX: bbox.minX - gsd, minY: bbox.minY - gsd, maxX: bbox.maxX + gsd, maxY: bbox.maxY + gsd };
  const { tiles, missing } = selectTiles(items, needed, options.year);
  const gt = await import('geotiff');

  const opened: Array<{ tile: Tile; url: string; tiff: GeoTIFF }> = [];
  for (const tile of tiles) {
    const url = cogAsset(tile.item, gsd);
    if (!url) {
      missing.push(tile.key);
      continue;
    }
    opened.push({ tile, url, tiff: await openCog(gt, http, url, signal) });
  }

  const g = opened.length > 0 ? await pickLevel(opened[0].tiff, resolution) : gsd;
  const mosaic = createMosaic(bbox, g);
  if (mosaic.width * mosaic.height > maxSourcePixels) {
    throw new RangeError(
      `reading ${mosaic.width}×${mosaic.height} source pixels at ${g} m exceeds maxSourcePixels ${maxSourcePixels}`,
    );
  }
  const footprint = mosaicBBox(mosaic);
  const sources: ElevationGrid['sources'] = [];

  for (const { tile, url, tiff } of opened) {
    if (!bboxIntersects(tile.bbox, footprint)) continue;
    const img = await imageAtResolution(tiff, g);
    if (!img) throw new Error(`${url} has no image at ${g} m; tiles disagree on overview levels`);
    const full = await tiff.getImage(0);
    const [originX, originY] = full.getOrigin();
    const win = tileWindow(mosaic, { originX, originY, width: img.getWidth(), height: img.getHeight() });
    if (!win) continue;
    const raster = await img.readRasters({ window: win.window, samples: [0], interleave: true, signal });
    const [c0, r0, c1, r1] = win.window;
    blit(mosaic, raster as ArrayLike<number>, c1 - c0, r1 - r0, win.destCol, win.destRow, full.getGDALNoData());
    sources.push({ id: tile.item.id, url, acquired: tile.item.properties.datetime ?? null, gsd: g });
  }

  const sampled = sampleGrid(mosaic, bbox, resolution);
  return {
    crs: LV95,
    verticalCrs: LN02,
    verticalReference: SWISSALTI3D_VERTICAL_REFERENCE,
    origin: { x: bbox.minX, y: bbox.maxY },
    resolution,
    width: sampled.width,
    height: sampled.height,
    values: sampled.values,
    noDataCount: sampled.noDataCount,
    hasData: sampled.noDataCount < sampled.width * sampled.height,
    sources,
    missingTiles: missing.sort(),
    attribution: [attributionFor('swissalti3d')],
  };
}

