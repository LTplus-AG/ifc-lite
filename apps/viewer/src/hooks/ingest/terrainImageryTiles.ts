/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fetch an XYZ mosaic or a WMS image over one terrain and drape it (#5942,
 * mapping spec §15.1). Viewer-only by construction: the raster carries no
 * `image` bytes, so the export has nothing to ship (§15.2 item 7).
 */

import proj4 from 'proj4';
import type { FederatedModel } from '@/store';
import { resolveProjectionOperation } from '@/lib/geo/reproject.js';
import type { GeoRasterPlacement, Parsed } from '@/lib/terrain-imagery/georaster.js';
import { borderedTexture } from '@/lib/terrain-imagery/raster-texture.js';
import {
  MAX_MOSAIC_TILES_PER_SIDE, validateTileSource, wmsRequest, xyzPlacement, xyzTileRange, xyzTileUrl,
  type PlanBounds, type TileSourceSpec,
} from '@/lib/terrain-imagery/tile-source.js';
import { drapeRasterOnTerrains, type DrapeOutcome } from './terrainImageryDrape.js';
import { terrainCrsOf } from './terrainImageryPlan.js';

/** The plan extent of a terrain's rendered surfaces, native units, easting/northing. */
export function terrainPlanBounds(model: Pick<FederatedModel, 'landXmlDocument'>): PlanBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const surface of model.landXmlDocument?.surfaces ?? []) {
    if (surface.renderState !== 'rendered') continue;
    for (const point of surface.points) {
      minX = Math.min(minX, point.easting); maxX = Math.max(maxX, point.easting);
      minY = Math.min(minY, point.northing); maxY = Math.max(maxY, point.northing);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

/** The tile mosaic over `bounds` (terrain CRS), stitched onto one canvas. */
async function xyzMosaic(spec: Extract<TileSourceSpec, { kind: 'xyz' }>, terrainCrs: string, bounds: PlanBounds) {
  const operation = await resolveProjectionOperation(terrainCrs);
  if (operation.kind === 'refused') return { ok: false as const, reason: `${terrainCrs} cannot be resolved (${operation.reason.replace(/-/g, ' ')}).` };
  const toLonLat = proj4(operation.definition, 'EPSG:4326');
  const [minX, minY, maxX, maxY] = bounds;
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].map((corner) => toLonLat.forward(corner) as number[]);
  const range = xyzTileRange([
    Math.min(...corners.map(([lon]) => lon)), Math.min(...corners.map(([, lat]) => lat)),
    Math.max(...corners.map(([lon]) => lon)), Math.max(...corners.map(([, lat]) => lat)),
  ], spec.zoom);
  const columns = range.xMax - range.xMin + 1;
  const rows = range.yMax - range.yMin + 1;
  if (columns > MAX_MOSAIC_TILES_PER_SIDE || rows > MAX_MOSAIC_TILES_PER_SIDE) {
    return { ok: false as const, reason: `Zoom ${spec.zoom} needs ${columns} × ${rows} tiles over this terrain; choose a lower zoom.` };
  }
  const placement = xyzPlacement(range);
  const canvas = new OffscreenCanvas(placement.width, placement.height);
  const context = canvas.getContext('2d');
  if (!context) return { ok: false as const, reason: 'This browser cannot compose a tile mosaic (no 2D canvas).' };
  const jobs: Array<Promise<void>> = [];
  for (let x = range.xMin; x <= range.xMax; x += 1) {
    for (let y = range.yMin; y <= range.yMax; y += 1) {
      jobs.push(fetchBitmap(xyzTileUrl(spec.urlTemplate, spec.zoom, x, y)).then((tile) => {
        context.drawImage(tile, (x - range.xMin) * 256, (y - range.yMin) * 256, 256, 256);
        tile.close();
      }));
    }
  }
  await Promise.all(jobs);
  return { ok: true as const, value: { bitmap: canvas.transferToImageBitmap(), placement } };
}

/** Fetch, place and drape a tile source on one terrain model. */
export async function drapeTileSource(model: FederatedModel, spec: TileSourceSpec): Promise<Parsed<DrapeOutcome[]>> {
  const invalid = validateTileSource(spec);
  if (invalid) return { ok: false, reason: invalid };
  const crs = terrainCrsOf(model.landXmlDocument ?? {});
  if (!crs.ok) return crs;
  const bounds = terrainPlanBounds(model);
  if (!bounds) return { ok: false, reason: 'The terrain has no rendered surface to request imagery for.' };
  let source: Parsed<{ bitmap: ImageBitmap; placement: GeoRasterPlacement }>;
  try {
    if (spec.kind === 'xyz') {
      source = await xyzMosaic(spec, crs.value, bounds);
    } else {
      const request = wmsRequest(spec, crs.value, bounds);
      source = request.ok
        ? { ok: true, value: { bitmap: await fetchBitmap(request.value.url), placement: request.value.placement } }
        : request;
    }
  } catch (error) {
    // A cross-origin refusal surfaces as a bare TypeError from fetch.
    return {
      ok: false,
      reason: `The tiles could not be fetched (${error instanceof Error ? error.message : String(error)}). `
        + 'The server must allow cross-origin requests from this viewer.',
    };
  }
  if (!source.ok) return source;
  const { bitmap, placement } = source.value;
  const host = new URL(spec.kind === 'xyz' ? spec.urlTemplate.replace(/[{}]/g, '') : spec.url).host;
  const name = spec.kind === 'xyz' ? `${host} tiles, zoom ${spec.zoom}` : `${host} WMS ${spec.layers}`;
  const outcomes = await drapeRasterOnTerrains({
    name, source: 'tiles', placement,
    texture: async (border) => borderedTexture(bitmap, placement.width, placement.height, border),
  }, [model.id]);
  return { ok: true, value: outcomes };
}
