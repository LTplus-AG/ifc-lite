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
 *
 * Nothing is dropped silently: hitting `maxRequests`, hitting `maxDepth` and
 * falling back from an over-long polygon to its bounding box (and any feature
 * that fallback could not test against the polygon) are all reported on the
 * result.
 */

import { featureProps, identify, identifyUrl, IDENTIFY_MAX_LIMIT, type IdentifyGeometry } from './api3.js';
import { attributionFor, type DatasetId } from './attribution.js';
import type { Attribution, BBox, Feature, FeatureQueryResult, Geometry, MultiPolygonGeometry, PolygonGeometry } from './contracts.js';
import type { HttpClient } from './http.js';
import { assertLv95BBox, clipRingToBBox, geometryBBox, geometryIntersectsPolygon, LV95 } from './lv95.js';

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
  /**
   * Stop after this many `identify` queries (cells). Default 500. A retry of
   * one query inside the HTTP client is not a further query, so this bounds
   * cells, not network sends; `networkRequests` reports the sends. What was collected so far is
   * returned with `requestLimitReached` and `truncated` set and the cells
   * never queried in `unqueriedCells`; it is not thrown away.
   */
  maxRequests?: number;
  /**
   * Longest request URL to send. A polygon travels as JSON in the GET query
   * string, so a parcel with hundreds of vertices can exceed URL limits.
   * Above this length a cell is queried by its bounding box instead and the
   * features are clipped to the polygon here; those cells are reported in
   * `bboxFallbackCells`. Default 6000.
   */
  maxUrlLength?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_URL_LENGTH = 6000;

function polygonsOf(area: BBox | PolygonGeometry | MultiPolygonGeometry): PolygonGeometry[] | null {
  if (!('type' in area)) return null;
  if (area.type === 'Polygon') return [area];
  if (area.type === 'MultiPolygon') return area.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
  throw new RangeError(`unsupported area geometry ${JSON.stringify((area as { type?: unknown }).type)}: pass a bbox, Polygon or MultiPolygon`);
}

/**
 * The query geometry for one cell: the cell itself, or the polygon clipped to
 * it (null when empty). `fallback` is set when the clipped polygon's URL would
 * exceed `maxUrlLength` and the cell's envelope is used instead.
 */
function cellGeometry(
  layer: string,
  cell: BBox,
  polygon: PolygonGeometry | null,
  maxUrlLength: number,
): { geometry: IdentifyGeometry; fallback: boolean } | null {
  if (!polygon) return { geometry: { kind: 'envelope', bbox: cell }, fallback: false };
  const rings = polygon.coordinates.map((r) => clipRingToBBox(r, cell));
  if (rings[0].length === 0) return null;
  const geometry: IdentifyGeometry = {
    kind: 'polygon',
    polygon: { type: 'Polygon', coordinates: rings.filter((r) => r.length > 0) },
  };
  if (identifyUrl({ layer, geometry, limit: IDENTIFY_MAX_LIMIT }).length <= maxUrlLength) return { geometry, fallback: false };
  return { geometry: { kind: 'envelope', bbox: cell }, fallback: true };
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
  area: BBox | PolygonGeometry | MultiPolygonGeometry,
  options: FeatureQueryOptions = {},
): Promise<FeatureQueryResult> {
  // A MultiPolygon is queried one member at a time and merged by feature id.
  const polygons = polygonsOf(area);
  const roots = polygons ? polygons.map((p) => ({ polygon: p, bbox: geometryBBox(p) })) : [{ polygon: null, bbox: area as BBox }];
  for (const r of roots) assertLv95BBox(r.bbox);
  const maxDepth = options.maxDepth ?? 6;
  const maxRequests = options.maxRequests ?? 500;
  const maxUrlLength = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  // `NaN` compares false with everything, so it would silently disable a budget.
  for (const [name, value] of [['maxDepth', maxDepth], ['maxRequests', maxRequests], ['maxUrlLength', maxUrlLength]] as const) {
    if (!(value >= 0)) throw new RangeError(`${name} must be a number >= 0, got ${value}`);
  }

  const byId = new Map<string, Feature>();
  const truncatedCells: BBox[] = [];
  const bboxFallbackCells: BBox[] = [];
  const unqueriedCells: BBox[] = [];
  let requests = 0;
  let networkRequests = 0;
  const queue: Array<{ cell: BBox; depth: number; polygon: PolygonGeometry | null }> = roots.map((r) => ({
    cell: r.bbox,
    depth: 0,
    polygon: r.polygon,
  }));
  while (queue.length > 0) {
    const { cell, depth, polygon } = queue.shift() as { cell: BBox; depth: number; polygon: PolygonGeometry | null };
    const query = cellGeometry(layer, cell, polygon, maxUrlLength);
    if (!query) continue;
    if (requests >= maxRequests) {
      unqueriedCells.push(cell);
      continue;
    }
    if (query.fallback) bboxFallbackCells.push(cell);
    requests++;
    const hits = await identify(http, { layer, geometry: query.geometry, limit: IDENTIFY_MAX_LIMIT,
      signal: options.signal,
      onSend: () => {
        networkRequests++;
      },
    });
    for (const f of hits) {
      const id = `${f.layerBodId}:${f.featureId ?? f.id}`;
      if (!byId.has(id)) {
        byId.set(id, { id: String(f.featureId ?? f.id), layer: f.layerBodId, geometry: f.geometry ?? null, properties: featureProps(f) });
      }
    }
    // A full page may hide more features: split. (Multi-table layers can return more than the limit.)
    if (hits.length >= IDENTIFY_MAX_LIMIT) {
      if (depth < maxDepth) queue.push(...quarters(cell).map((c) => ({ cell: c, depth: depth + 1, polygon })));
      else truncatedCells.push(cell);
    }
  }

  let features = [...byId.values()];
  const unverifiedFeatureIds: string[] = [];
  // Cells queried by bounding box return features beside the polygon: clip them here.
  // A feature without geometry cannot be tested; it is kept, and named in `unverifiedFeatureIds`.
  if (bboxFallbackCells.length > 0 && polygons) {
    features = features.filter((f) => {
      if (!f.geometry) {
        unverifiedFeatureIds.push(f.id);
        return true;
      }
      return polygons.some((p) => geometryIntersectsPolygon(f.geometry as Geometry, p));
    });
  }

  const requestLimitReached = unqueriedCells.length > 0;
  const dataset = LAYER_DATASET[layer];
  return {
    features,
    requests,
    networkRequests,
    truncatedCells,
    requestLimitReached,
    unqueriedCells,
    truncated: requestLimitReached || truncatedCells.length > 0,
    bboxFallbackCells,
    unverifiedFeatureIds,
    crs: LV95,
    attribution: [dataset ? attributionFor(dataset) : unrecordedLayerAttribution(layer)],
  };
}
