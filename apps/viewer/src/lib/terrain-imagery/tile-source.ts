/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map tiles as a drape source (#5942, mapping spec §15.1): an XYZ tile
 * template at a chosen zoom, or a WMS `GetMap` at a chosen resolution.
 *
 * VIEWER-ONLY (§15.2 item 7): the bytes are the tile provider's, not ours to
 * redistribute, and the coverage depends on the zoom chosen, so a tile drape
 * is never written to an export.
 *
 * Placement is exact by construction, never inferred from pixels: an XYZ
 * mosaic is a rectangle of the EPSG:3857 tile grid, and a WMS image is
 * requested in the terrain's own CRS over the terrain's own extent. WMS 1.1.1
 * is used on purpose — its `SRS`/`BBOX` are always `x, y` = easting,
 * northing, where 1.3.0 follows each CRS's authority axis order and would
 * put a northing-first CRS's bounding box on its side: the coordinate-order
 * trap again.
 */

import type { GeoRasterPlacement, Parsed } from './georaster.js';

/** Half the EPSG:3857 world width, metres. */
const WEB_MERCATOR_HALF = 20_037_508.342789244;
const TILE_SIZE = 256;
/** A mosaic above this many tiles per side would exceed the texture limit. */
export const MAX_MOSAIC_TILES_PER_SIDE = 16;
/** A WMS request above this many pixels per side is refused, not truncated. */
export const MAX_WMS_PIXELS_PER_SIDE = 4096;

export type TileSourceSpec =
  | { kind: 'xyz'; urlTemplate: string; zoom: number }
  | { kind: 'wms'; url: string; layers: string; resolution: number };

export interface TileRange { zoom: number; xMin: number; xMax: number; yMin: number; yMax: number }

/** Plan extent `[minX, minY, maxX, maxY]`, easting/northing order. */
export type PlanBounds = readonly [number, number, number, number];

/** Only http(s) endpoints, and an XYZ template must name all three indices. */
export function validateTileSource(spec: TileSourceSpec): string | null {
  const url = spec.kind === 'xyz' ? spec.urlTemplate : spec.url;
  if (!/^https?:\/\//i.test(url.trim())) return 'The tile source must be an http(s) URL.';
  if (spec.kind === 'xyz') {
    if (!['{z}', '{x}', '{y}'].every((token) => spec.urlTemplate.includes(token))) {
      return 'An XYZ template must contain {z}, {x} and {y}.';
    }
    if (!Number.isInteger(spec.zoom) || spec.zoom < 0 || spec.zoom > 24) return 'The zoom must be a whole number from 0 to 24.';
  } else {
    if (!spec.layers.trim()) return 'A WMS request needs at least one layer.';
    if (!(spec.resolution > 0)) return 'The WMS resolution must be a positive ground distance per pixel.';
  }
  return null;
}

/** Tiles of the EPSG:3857 grid covering a longitude/latitude box at `zoom`. */
export function xyzTileRange(bounds: PlanBounds, zoom: number): TileRange {
  const count = 2 ** zoom;
  const x = (lon: number) => Math.min(count - 1, Math.max(0, Math.floor(((lon + 180) / 360) * count)));
  const y = (lat: number) => {
    const radians = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
    const fraction = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
    return Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
  };
  const [minLon, minLat, maxLon, maxLat] = bounds;
  return { zoom, xMin: x(minLon), xMax: x(maxLon), yMin: y(maxLat), yMax: y(minLat) };
}

/** Exact EPSG:3857 placement of a stitched tile range. */
export function xyzPlacement(range: TileRange): GeoRasterPlacement {
  const resolution = (2 * WEB_MERCATOR_HALF) / (TILE_SIZE * 2 ** range.zoom);
  return {
    width: (range.xMax - range.xMin + 1) * TILE_SIZE,
    height: (range.yMax - range.yMin + 1) * TILE_SIZE,
    affine: {
      a: resolution, b: 0, d: 0, e: -resolution,
      c: -WEB_MERCATOR_HALF + range.xMin * TILE_SIZE * resolution,
      f: WEB_MERCATOR_HALF - range.yMin * TILE_SIZE * resolution,
    },
    crs: 'EPSG:3857',
    crsSource: 'XYZ tile grid',
    placement: 'tiles',
  };
}

export function xyzTileUrl(template: string, zoom: number, x: number, y: number): string {
  return template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** A WMS 1.1.1 GetMap over `bounds` in `crs`, and the placement it yields. */
export function wmsRequest(
  spec: Extract<TileSourceSpec, { kind: 'wms' }>, crs: string, bounds: PlanBounds,
): Parsed<{ url: string; placement: GeoRasterPlacement }> {
  const [minX, minY, maxX, maxY] = bounds;
  const width = Math.ceil((maxX - minX) / spec.resolution);
  const height = Math.ceil((maxY - minY) / spec.resolution);
  if (!(width > 0 && height > 0)) return { ok: false, reason: 'The terrain has no plan extent to request imagery for.' };
  if (width > MAX_WMS_PIXELS_PER_SIDE || height > MAX_WMS_PIXELS_PER_SIDE) {
    return { ok: false, reason: `${width} × ${height} px at ${spec.resolution} per pixel exceeds ${MAX_WMS_PIXELS_PER_SIDE} px per side; choose a coarser resolution.` };
  }
  // Snap the far corner to whole pixels so the placement is exact.
  const right = minX + width * spec.resolution;
  const top = minY + height * spec.resolution;
  const url = new URL(spec.url);
  const params: Record<string, string> = {
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: spec.layers, STYLES: '', SRS: crs,
    BBOX: [minX, minY, right, top].join(','), WIDTH: String(width), HEIGHT: String(height), FORMAT: 'image/png',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    ok: true,
    value: {
      url: url.toString(),
      placement: {
        width, height,
        affine: { a: spec.resolution, b: 0, d: 0, e: -spec.resolution, c: minX, f: top },
        crs, crsSource: 'WMS 1.1.1 SRS', placement: 'tiles',
      },
    },
  };
}
