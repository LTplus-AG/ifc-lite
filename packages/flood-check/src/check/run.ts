/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fetch what the pure check needs (one hazard raster, terrain) and run it. */

import { prepareFootprint } from '../region.js';
import { FloodCheckRefusal } from '../errors.js';
import { normalizeCrs, sameCrs } from '../crs.js';
import { bboxOf, expandBBox } from '../geom.js';
import type { ModelFacts } from '../model/facts.js';
import {
  type BuildingFootprintSource,
  type HazardProvider,
  type MapBBox,
  type MapPoint,
  type RenderingConfirmation,
  type TerrainSampler,
  type TerrainSource,
} from '../types.js';
import { assertCompatible, checkWith, rasterShowsNoClass, type CheckOptions, type FloodCheckResult } from './check.js';
import {
  outlineTerrainPoints,
  planSamples,
  pointKey,
  resolveSampling,
  terrainSamplerFromGrid,
  terrainSamplerFromPoints,
} from './sampling.js';

export interface RunOptions extends Omit<CheckOptions, 'renderingConfirmation'> {
  /**
   * Hazard raster cell size, metres. The provider's default when omitted. May
   * not exceed half the provider's model cell: coarser cells can drop a thin
   * flow path.
   */
  cellSize?: number;
  /** Terrain grid resolution when the source offers grids, metres. Default 0.5; may only be made finer. */
  terrainResolution?: number;
  /**
   * Largest plan extent, metres, that the candidates, footprint and rings may
   * span before the check refuses (`georeference-implausible`): a building's
   * elements spread over kilometres means a wrong length unit or map scale.
   * Default 1000. A larger value yields results for a large site, but then the
   * georeference counts as unconfirmed and no element gets a favourable outcome.
   */
  maxPlanExtent?: number;
  signal?: AbortSignal;
  /** Other buildings' footprints, fetched for the check's box (`CheckOptions.otherBuildings` when already resolved). */
  buildings?: BuildingFootprintSource;
}

/** The box covering the footprint, every candidate and every ring, plus two raster cells. */
export function checkBBox(facts: ModelFacts, options: RunOptions = {}): MapBBox {
  const s = resolveSampling();
  const points: MapPoint[] = [...facts.candidates.map((c) => c.position), ...facts.footprint.rings.flat()];
  const box = bboxOf(points);
  if (!box) throw new FloodCheckRefusal('no-candidates', 'the model facts list no candidates and no footprint');
  return expandBBox(box, Math.max(...s.ringDistances) + 2 * (options.cellSize ?? 1));
}

function overlaps(a: MapBBox, b: MapBBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Refuse when the elements spread further than one building can: a wrong unit or scale reading. */
const DEFAULT_MAX_PLAN_EXTENT = 1000;
const DEFAULT_TERRAIN_RESOLUTION = 0.5;

/** Returns a reason the georeference is unconfirmed when the extent passes only a raised limit. */
function assertPlausibleExtent(bbox: MapBBox, options: RunOptions): string | null {
  const limit = options.maxPlanExtent ?? DEFAULT_MAX_PLAN_EXTENT;
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  if (w > limit || h > limit) {
    throw new FloodCheckRefusal(
      'georeference-implausible',
      `the candidates, footprint and ground samples span ${w.toFixed(0)} m x ${h.toFixed(0)} m, more than the ${limit} m one building ` +
        "can cover. This indicates a wrong length unit or map scale in the model's georeferencing (IfcMapConversion.Scale, the project " +
        'length unit), not flood exposure; no element results are reported. Pass mapScale or fix the model, or raise maxPlanExtent for a large site.',
    );
  }
  if (w > DEFAULT_MAX_PLAN_EXTENT || h > DEFAULT_MAX_PLAN_EXTENT) {
    return `the elements span ${w.toFixed(0)} m x ${h.toFixed(0)} m, more than the default ${DEFAULT_MAX_PLAN_EXTENT} m, and were accepted only by a raised maxPlanExtent`;
  }
  return null;
}

async function terrainFor(
  facts: ModelFacts,
  source: TerrainSource,
  bbox: MapBBox,
  options: RunOptions,
): Promise<TerrainSampler> {
  if (source.grid) {
    const grid = await source.grid(bbox, { resolution: options.terrainResolution ?? DEFAULT_TERRAIN_RESOLUTION, signal: options.signal });
    const gridVertical = normalizeCrs(grid.verticalCrs);
    if (!gridVertical || gridVertical !== normalizeCrs(source.verticalCrs) || !sameCrs(grid.crs, source.crs)) {
      throw new FloodCheckRefusal(
        'vertical-datum-mismatch',
        `the terrain grid is in ${grid.crs} / ${grid.verticalCrs}; its source declared ${source.crs} / ${source.verticalCrs}`,
      );
    }
    return terrainSamplerFromGrid(grid, { verticalAccuracy: source.verticalAccuracy });
  }
  if (!source.heightAt) throw new TypeError('the terrain source offers neither heightAt nor grid');
  const s = resolveSampling();
  const heights = new Map<string, number | null>();
  const region = prepareFootprint(facts.footprint);
  const points = [
    ...facts.candidates.flatMap((candidate) => planSamples(candidate, region, s).points.map((p) => p.point)),
    ...outlineTerrainPoints(region, s),
  ];
  for (const point of points) {
    const key = pointKey(point);
    if (heights.has(key)) continue;
    options.signal?.throwIfAborted();
    heights.set(key, await source.heightAt(point, options.signal));
  }
  return terrainSamplerFromPoints(source, heights);
}

/**
 * Refuse early on CRS / vertical CRS mismatch or an implausible plan extent,
 * fetch one hazard raster over the building and the terrain under it, confirm
 * the layer renders when that raster is wholly transparent, and run
 * {@link checkFloodExposure} (the raster carries the provider's coverage perimeter).
 */
export async function runFloodCheck(
  facts: ModelFacts,
  provider: HazardProvider,
  terrain: TerrainSource,
  options: RunOptions = {},
): Promise<FloodCheckResult> {
  assertCompatible(facts, provider.crs, terrain);
  if (options.cellSize !== undefined && !(options.cellSize > 0 && options.cellSize <= provider.modelCellSize / 2)) {
    throw new RangeError(
      `cellSize must be > 0 and at most ${provider.modelCellSize / 2} m (half the ${provider.modelCellSize} m model raster), got ${options.cellSize}`,
    );
  }
  if (options.terrainResolution !== undefined && !(options.terrainResolution > 0 && options.terrainResolution <= DEFAULT_TERRAIN_RESOLUTION)) {
    throw new RangeError(`terrainResolution must be > 0 and at most ${DEFAULT_TERRAIN_RESOLUTION} m, got ${options.terrainResolution}`);
  }
  if (facts.candidates.length === 0) {
    throw new FloodCheckRefusal('no-candidates', 'the model has no candidate elements (doors, windows, openings, light wells, ramps, equipment) in scope');
  }
  const bbox = checkBBox(facts, options);
  if (!overlaps(bbox, provider.extent)) {
    throw new FloodCheckRefusal(
      'outside-provider-extent',
      `the model lies at E ${bbox.minX.toFixed(0)}, N ${bbox.minY.toFixed(0)}, outside the extent of ${provider.id}; check the georeferencing`,
    );
  }
  const extentReason = assertPlausibleExtent(bbox, options);
  const fetched = await provider.fetchRaster({ bbox, crs: provider.crs, cellSize: options.cellSize, signal: options.signal });
  // A sample counts as covered only when the raster's own coverage and the provider's (when it states one) both say so.
  const own = fetched.covers;
  const perimeter = provider.covers;
  const raster: typeof fetched = perimeter
    ? { ...fetched, covers: (p) => (own === 'everywhere' || own(p) === true ? perimeter(p) : own(p)) }
    : fetched;
  let renderingConfirmation: RenderingConfirmation | undefined;
  if (provider.confirmRendering && rasterShowsNoClass(raster)) {
    renderingConfirmation = await provider.confirmRendering(options.signal);
  }
  const sampler = await terrainFor(facts, terrain, bbox, options);
  if (options.buildings && !sameCrs(options.buildings.crs, provider.crs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the buildings source is in ${options.buildings.crs}; the hazard map is in ${provider.crs}`);
  }
  const answer = options.buildings ? await options.buildings.footprints(bbox, options.signal) : undefined;
  const otherBuildings = answer ? { ...answer, extent: answer.extent ?? bbox } : options.otherBuildings;
  return checkWith(facts, raster, sampler, { ...options, otherBuildings, renderingConfirmation }, extentReason ? [extentReason] : []);
}
