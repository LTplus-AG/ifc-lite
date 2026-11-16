/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `buildSiteContext`: fetch, mesh and describe the site around a centre point. */

import type { ElevationGrid } from '@ifc-lite/geodata-ch';
import {
  assertInCoverage,
  assertRadius,
  gridNodeCount,
  MAX_TERRAIN_NODES,
  planOrigin,
  resolveResolution,
  SiteContextCoverageError,
  siteBBox,
} from './frame.js';
import { buildingsLayer } from './buildings-layer.js';
import { footprintCentroid, parcelLayer } from './parcel-layer.js';
import { terrainLayer } from './terrain-layer.js';
import type { BuildSiteContextOptions, SiteContextDocument, SiteContextLayer, SiteContextLayerKind, SiteContextOriginHeight } from './types.js';

const KINDS: readonly SiteContextLayerKind[] = ['terrain', 'parcel', 'buildings'];

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('site context build aborted', 'AbortError');
}

/** H0: the terrain height at the node nearest the centre, else the mean of the grid, rounded to whole metres; `null` when the grid has no height at all. */
export function originHeight(grid: Pick<ElevationGrid, 'origin' | 'resolution' | 'width' | 'height' | 'values'>, x: number, y: number): number | null {
  const col = Math.min(Math.max(Math.round((x - grid.origin.x) / grid.resolution), 0), grid.width - 1);
  const row = Math.min(Math.max(Math.round((grid.origin.y - y) / grid.resolution), 0), grid.height - 1);
  const h = grid.values[row * grid.width + col];
  if (Number.isFinite(h)) return Math.round(h);
  let sum = 0;
  let n = 0;
  for (const v of grid.values) {
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? Math.round(sum / n) : null;
}

export async function buildSiteContext(options: BuildSiteContextOptions): Promise<SiteContextDocument> {
  const { centre, radius, geodata, signal, onProgress, onLayer } = options;
  const kinds = [...new Set(options.layers)];
  for (const k of kinds) if (!KINDS.includes(k)) throw new RangeError(`unknown site-context layer "${k}"; expected ${KINDS.join(', ')}`);
  if (kinds.length === 0) throw new RangeError('no site-context layers requested');
  assertRadius(radius);
  assertInCoverage(centre);
  const resolution = resolveResolution(2 * radius, options.resolution);
  const bbox = siteBBox(centre, radius, resolution);
  const nodes = gridNodeCount(bbox, resolution);
  if (nodes > MAX_TERRAIN_NODES) {
    throw new RangeError(`${nodes} terrain nodes at ${resolution} m exceeds ${MAX_TERRAIN_NODES}; use a coarser resolution or 'auto'`);
  }

  const [e0, n0] = planOrigin(centre);
  let grid: ElevationGrid | null = null;
  let gridError: string | null = null;
  if (kinds.includes('terrain') || kinds.includes('parcel')) {
    abortIfNeeded(signal);
    onProgress?.({ stage: 'terrain-grid', message: `elevation grid ${bbox.maxX - bbox.minX} × ${bbox.maxY - bbox.minY} m at ${resolution} m` });
    try {
      grid = await geodata.elevationGrid(bbox, { resolution, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      gridError = err instanceof Error ? err.message : String(err);
    }
    if (grid && !grid.hasData) {
      throw new SiteContextCoverageError(centre, `swissALTI3D has no data in the site box (missing tiles: ${grid.missingTiles.join(', ') || 'none listed'})`);
    }
  }
  const terrainHeight = grid ? originHeight(grid, centre.x, centre.y) : null;
  // Without a terrain height H0 is 0 as a frame offset only, and the document says why (#10480 review).
  const heightInfo: SiteContextOriginHeight = terrainHeight !== null
    ? { terrainHeight }
    : {
        terrainHeight: null,
        reason: grid ? 'the elevation grid has no height in the site box'
          : gridError !== null ? `the elevation grid could not be read: ${gridError}`
            : 'no terrain was requested (only buildings), so no terrain height was read; H0 is 0 as a frame offset',
      };
  const h0 = terrainHeight ?? 0;

  const layers: SiteContextLayer[] = [];
  for (const kind of kinds) {
    abortIfNeeded(signal);
    let layer: SiteContextLayer;
    if (kind === 'terrain') {
      onProgress?.({ stage: 'terrain-mesh', message: 'meshing terrain' });
      layer = grid
        ? terrainLayer(grid, h0)
        : {
            kind,
            features: [],
            attribution: [],
            issues: [{ code: 'terrain-fetch-failed', severity: 'error', message: `elevation grid could not be read: ${gridError}` }],
            complete: false,
          };
    } else if (kind === 'parcel') {
      onProgress?.({ stage: 'parcel', message: 'looking up the parcel' });
      const point = options.subject?.footprint?.length ? footprintCentroid(options.subject.footprint) : centre;
      layer = await parcelLayer({
        geodata,
        point,
        egrid: options.subject?.egrid,
        grid,
        h0,
        signal,
        onOereb: () => onProgress?.({ stage: 'oereb', message: 'looking up the ÖREB extract' }),
      });
      if (!grid && gridError) {
        layer.issues.push({ code: 'terrain-fetch-failed', severity: 'error', message: `elevation grid could not be read: ${gridError}` });
      }
    } else {
      onProgress?.({ stage: 'buildings', message: 'reading neighbouring buildings' });
      layer = await buildingsLayer({ centre, radius, subject: options.subject, options: options.buildings, signal });
    }
    layers.push(layer);
    onLayer?.(layer);
  }
  onProgress?.({ stage: 'done', message: 'site context built' });
  return { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: [e0, n0, h0], originHeight: heightInfo, layers };
}
