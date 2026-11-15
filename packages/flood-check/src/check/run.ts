/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fetch what the pure check needs (one hazard raster, terrain) and run it. */

import { FloodCheckRefusal } from '../errors.js';
import { sameCrs, sameVerticalDatum } from '../crs.js';
import { bboxOf, expandBBox } from '../geom.js';
import type { ModelFacts } from '../model/facts.js';
import type { HazardProvider, MapBBox, MapPoint, TerrainSampler, TerrainSource } from '../types.js';
import { assertCompatible, checkFloodExposure, type CheckOptions, type FloodCheckResult } from './check.js';
import {
  planSamples,
  pointKey,
  resolveSampling,
  terrainSamplerFromGrid,
  terrainSamplerFromPoints,
} from './sampling.js';

export interface RunOptions extends CheckOptions {
  /** Hazard raster cell size, metres. The provider's default when omitted. */
  cellSize?: number;
  /** Terrain grid resolution when the source offers grids, metres. Default 0.5. */
  terrainResolution?: number;
  signal?: AbortSignal;
}

/** The box covering the footprint, every candidate and every ring, plus two raster cells. */
export function checkBBox(facts: ModelFacts, options: RunOptions = {}): MapBBox {
  const s = resolveSampling(options);
  const points: MapPoint[] = [...facts.candidates.map((c) => c.position), ...facts.footprint.rings.flat()];
  const box = bboxOf(points);
  if (!box) throw new FloodCheckRefusal('no-candidates', 'the model facts list no candidates and no footprint');
  return expandBBox(box, Math.max(...s.ringDistances) + 2 * (options.cellSize ?? 1));
}

function overlaps(a: MapBBox, b: MapBBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

async function terrainFor(
  facts: ModelFacts,
  source: TerrainSource,
  bbox: MapBBox,
  options: RunOptions,
): Promise<TerrainSampler> {
  if (source.grid) {
    const grid = await source.grid(bbox, { resolution: options.terrainResolution ?? 0.5, signal: options.signal });
    if (!sameVerticalDatum(grid.verticalReference, source.verticalReference) || !sameCrs(grid.crs, source.crs)) {
      throw new FloodCheckRefusal(
        'vertical-datum-mismatch',
        `the terrain grid is in ${grid.crs} / ${grid.verticalReference}; its source declared ${source.crs} / ${source.verticalReference}`,
      );
    }
    return terrainSamplerFromGrid(grid);
  }
  if (!source.heightAt) throw new TypeError('the terrain source offers neither heightAt nor grid');
  const s = resolveSampling(options);
  const heights = new Map<string, number | null>();
  for (const candidate of facts.candidates) {
    for (const { point } of planSamples(candidate, facts.footprint, s).points) {
      const key = pointKey(point);
      if (heights.has(key)) continue;
      options.signal?.throwIfAborted();
      heights.set(key, await source.heightAt(point, options.signal));
    }
  }
  return terrainSamplerFromPoints(source.crs, source.verticalReference, heights);
}

/**
 * Refuse early on CRS / datum mismatch, fetch one hazard raster over the
 * building and the terrain under it, and run {@link checkFloodExposure}.
 */
export async function runFloodCheck(
  facts: ModelFacts,
  provider: HazardProvider,
  terrain: TerrainSource,
  options: RunOptions = {},
): Promise<FloodCheckResult> {
  assertCompatible(facts, provider.crs, terrain);
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
  const raster = await provider.fetchRaster({ bbox, crs: provider.crs, cellSize: options.cellSize, signal: options.signal });
  const sampler = await terrainFor(facts, terrain, bbox, options);
  return checkFloodExposure(facts, raster, sampler, options);
}
