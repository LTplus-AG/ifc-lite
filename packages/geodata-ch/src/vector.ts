/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Features of one api3 layer inside a box or polygon, beating `identify`'s
 * 200-feature cap by recursive quad splitting.
 *
 * ifc-site split every query into fixed ~250 m cells. Splitting only cells
 * that come back full costs one request per cell for sparse areas and still
 * converges in dense ones. `offset` paging is documented, but on 2026-11-15
 * two consecutive pages of `ch.swisstopo.swisstlm3d-strassen` overlapped
 * (the result order is not stable), so it is not used.
 *
 * Returned geometries are whole features, not clipped to the area: a road
 * crossing the boundary comes back entire, once.
 */

import { featureProps, identify, IDENTIFY_MAX_LIMIT, type IdentifyGeometry } from './api3.js';
import { attributionFor, type DatasetId } from './attribution.js';
import type { Attribution, BBox, Feature, FeatureQueryResult, PolygonGeometry } from './contracts.js';
import type { HttpClient } from './http.js';
import { assertLv95BBox, clipRingToBBox, geometryBBox, LV95 } from './lv95.js';

/** Layers this package has checked live, with the dataset whose terms apply. */
export const VECTOR_LAYERS = {
  roads: 'ch.swisstopo.swisstlm3d-strassen',
  railways: 'ch.swisstopo.swisstlm3d-eisenbahnnetz',
  waterNetwork: 'ch.swisstopo.swisstlm3d-gewaessernetz',
  buildingRegister: 'ch.bfs.gebaeude_wohnungs_register',
} as const;

const LAYER_DATASET: Record<string, DatasetId> = {
  [VECTOR_LAYERS.roads]: 'swisstlm3d',
  [VECTOR_LAYERS.railways]: 'swisstlm3d',
  [VECTOR_LAYERS.waterNetwork]: 'swisstlm3d',
  [VECTOR_LAYERS.buildingRegister]: 'gwr',
  'ch.kantone.cadastralwebmap-farbe': 'cadastre',
};

/** Attribution for a layer whose terms this package has not read: says so instead of staying silent. */
function unrecordedLayerAttribution(layer: string): Attribution {
  return {
    datasetId: layer,
    text: 'Source: geo.admin.ch',
    licence: 'Not recorded by @ifc-lite/geodata-ch',
    termsUrl: 'https://www.geocat.ch/',
    restrictions: [`Terms for ${layer} were not checked; read its geocat.ch metadata ("Legal restrictions") before use`],
    termsVerifiedOn: null,
  };
}

export interface FeatureQueryOptions {
  /**
   * Maximum split depth; depth d cells are 1/2^d of the area's side. Default
   * 6 (a 1 km box goes down to ~16 m cells). Cells still full at this depth
   * are reported in `truncatedCells`.
   */
  maxDepth?: number;
  /** Refuse to issue more requests than this. Default 500. */
  maxRequests?: number;
  signal?: AbortSignal;
}

function isPolygon(a: BBox | PolygonGeometry): a is PolygonGeometry {
  return (a as PolygonGeometry).type === 'Polygon';
}

/** The query geometry for one cell: the cell itself, or the polygon clipped to it (null when empty). */
function cellGeometry(cell: BBox, polygon: PolygonGeometry | null): IdentifyGeometry | null {
  if (!polygon) return { kind: 'envelope', bbox: cell };
  const rings = polygon.coordinates.map((r) => clipRingToBBox(r, cell));
  if (rings[0].length === 0) return null;
  return { kind: 'polygon', polygon: { type: 'Polygon', coordinates: rings.filter((r) => r.length > 0) } };
}

function quarters(b: BBox): BBox[] {
  const mx = (b.minX + b.maxX) / 2;
  const my = (b.minY + b.maxY) / 2;
  return [
    { minX: b.minX, minY: b.minY, maxX: mx, maxY: my },
    { minX: mx, minY: b.minY, maxX: b.maxX, maxY: my },
    { minX: b.minX, minY: my, maxX: mx, maxY: b.maxY },
    { minX: mx, minY: my, maxX: b.maxX, maxY: b.maxY },
  ];
}

export async function featuresInArea(
  http: HttpClient,
  layer: string,
  area: BBox | PolygonGeometry,
  options: FeatureQueryOptions = {},
): Promise<FeatureQueryResult> {
  const polygon = isPolygon(area) ? area : null;
  const root = polygon ? geometryBBox(polygon) : (area as BBox);
  assertLv95BBox(root);
  const maxDepth = options.maxDepth ?? 6;
  const maxRequests = options.maxRequests ?? 500;

  const byId = new Map<string, Feature>();
  const truncatedCells: BBox[] = [];
  let requests = 0;
  const queue: Array<{ cell: BBox; depth: number }> = [{ cell: root, depth: 0 }];
  while (queue.length > 0) {
    const { cell, depth } = queue.shift() as { cell: BBox; depth: number };
    const geometry = cellGeometry(cell, polygon);
    if (!geometry) continue;
    if (requests >= maxRequests) {
      throw new Error(`feature query on ${layer} needs more than maxRequests=${maxRequests} requests; narrow the area`);
    }
    requests++;
    const hits = await identify(http, { layer, geometry, limit: IDENTIFY_MAX_LIMIT, signal: options.signal });
    for (const f of hits) {
      const id = `${f.layerBodId}:${f.featureId ?? f.id}`;
      if (!byId.has(id)) {
        byId.set(id, { id: String(f.featureId ?? f.id), layer: f.layerBodId, geometry: f.geometry ?? null, properties: featureProps(f) });
      }
    }
    // A full page may hide more features: split. (Multi-table layers can return more than the limit.)
    if (hits.length >= IDENTIFY_MAX_LIMIT) {
      if (depth < maxDepth) queue.push(...quarters(cell).map((c) => ({ cell: c, depth: depth + 1 })));
      else truncatedCells.push(cell);
    }
  }

  const dataset = LAYER_DATASET[layer];
  return {
    features: [...byId.values()],
    requests,
    truncatedCells,
    crs: LV95,
    attribution: [dataset ? attributionFor(dataset) : unrecordedLayerAttribution(layer)],
  };
}
