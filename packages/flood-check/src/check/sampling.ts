/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the check looks for the ground next to an element.
 *
 * The hazard model raised every building footprint by 5 m, so a footprint
 * carries no depth; the water that matters flows along the façade. Each
 * candidate is anchored on the footprint outline (its own position when it is
 * outside, else the nearest outline point) and the map is read on rings
 * around that anchor, keeping only points clearly outside the footprint.
 *
 * Defaults: rings at 2 m and 3 m, 16 directions, points at least 1 m outside
 * the footprint. 2 m clears the 1 m model raster by two cells and absorbs
 * about 1 m of disagreement between the model's outline and the footprint the
 * hazard model raised, plus the one-pixel antialiased edge band; the 3 m ring
 * is a second chance when the first falls on such a band. Going further out
 * would start reading flow paths that do not touch the façade.
 */

import { closestBoundaryPoint, signedDistance } from '../geom.js';
import type { CandidateFact, ModelFacts } from '../model/facts.js';
import {
  CELL_NO_RUNOFF,
  CELL_UNCLASSIFIED,
  type ClassifiedHazardRaster,
  type CoverageTest,
  type MapPoint,
  type TerrainGrid,
  type TerrainSampler,
} from '../types.js';

export interface SamplingOptions {
  /** Ring radii around the anchor, metres. Default [2, 3]. */
  ringDistances?: readonly number[];
  /** Directions per ring. Default 16. */
  directions?: number;
  /** A sample must lie at least this far outside the footprint, metres. Default 1.0. */
  minOutsideDistance?: number;
}

export interface ResolvedSampling {
  ringDistances: readonly number[];
  directions: number;
  minOutsideDistance: number;
}

export function resolveSampling(options: SamplingOptions = {}): ResolvedSampling {
  return {
    ringDistances: options.ringDistances ?? [2, 3],
    directions: options.directions ?? 16,
    minOutsideDistance: options.minOutsideDistance ?? 1,
  };
}

export interface SamplePlan {
  anchor: MapPoint;
  anchorBasis: 'element' | 'nearest-outline-point';
  /** How far the anchor was moved from the element's position to reach the outline, metres (0 when not moved). */
  anchorOffset: number;
  /** Ring points outside the footprint, in ring then direction order. */
  points: Array<{ point: MapPoint; ring: number }>;
  /** Ring points dropped for lying inside or too close to the footprint. */
  rejected: number;
}

export function planSamples(candidate: CandidateFact, footprint: ModelFacts['footprint'], s: ResolvedSampling): SamplePlan {
  const rings = footprint.rings;
  const d = signedDistance(candidate.position, rings);
  let anchor = candidate.position;
  let anchorBasis: SamplePlan['anchorBasis'] = 'element';
  let anchorOffset = 0;
  if (d <= 0) {
    const nearest = closestBoundaryPoint(candidate.position, rings);
    if (nearest) {
      anchor = nearest.point;
      anchorBasis = 'nearest-outline-point';
      anchorOffset = nearest.distance;
    }
  }
  const points: SamplePlan['points'] = [];
  let rejected = 0;
  for (const ring of s.ringDistances) {
    for (let k = 0; k < s.directions; k++) {
      const a = (2 * Math.PI * k) / s.directions;
      const p = { x: anchor.x + ring * Math.cos(a), y: anchor.y + ring * Math.sin(a) };
      if (signedDistance(p, rings) >= s.minOutsideDistance) points.push({ point: p, ring });
      else rejected++;
    }
  }
  return { anchor, anchorBasis, anchorOffset, points, rejected };
}

/** What a raster says at a point. `outside-coverage`: outside (or too near) the perimeter the map covers. */
export type CellReading =
  | { kind: 'class'; code: number }
  | { kind: 'no-runoff' }
  | { kind: 'unclassified' }
  | { kind: 'outside' }
  | { kind: 'outside-coverage' };

export function readCell(raster: ClassifiedHazardRaster, p: MapPoint, covers?: CoverageTest): CellReading {
  if (covers && covers(p) !== true) return { kind: 'outside-coverage' };
  const col = Math.floor((p.x - raster.origin.x) / raster.cellSize);
  const row = Math.floor((raster.origin.y - p.y) / raster.cellSize);
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return { kind: 'outside' };
  const code = raster.cells[row * raster.width + col];
  if (code === CELL_NO_RUNOFF) return { kind: 'no-runoff' };
  if (code === CELL_UNCLASSIFIED || code > raster.classes.length) return { kind: 'unclassified' };
  return { kind: 'class', code };
}

/**
 * Bilinear interpolation over a terrain grid, honouring its `sampling`
 * convention (`node` or `cell-centre`, see {@link TerrainGrid}); null outside
 * the grid, next to a NaN, or when the grid says it has no data.
 */
export function terrainSamplerFromGrid(grid: TerrainGrid, options: { verticalAccuracy?: number } = {}): TerrainSampler {
  if (grid.sampling !== 'node' && grid.sampling !== 'cell-centre') {
    throw new TypeError(`TerrainGrid.sampling must be 'node' or 'cell-centre', got ${JSON.stringify(grid.sampling)}`);
  }
  const shift = grid.sampling === 'cell-centre' ? 0.5 : 0;
  const empty = grid.hasData === false;
  return {
    crs: grid.crs,
    verticalCrs: grid.verticalCrs,
    verticalReference: grid.verticalReference,
    verticalAccuracy: options.verticalAccuracy,
    heightAt(p: MapPoint): number | null {
      if (empty) return null;
      // Fractional node index: node (c, r) sits at origin + (c + shift, -(r + shift)) * resolution.
      const fx = (p.x - grid.origin.x) / grid.resolution - shift;
      const fy = (grid.origin.y - p.y) / grid.resolution - shift;
      if (!(fx >= 0 && fy >= 0 && fx <= grid.width - 1 && fy <= grid.height - 1)) return null;
      const c0 = Math.min(Math.floor(fx), grid.width - 1);
      const r0 = Math.min(Math.floor(fy), grid.height - 1);
      const tx = fx - c0;
      const ty = fy - r0;
      // Only nodes with a non-zero weight count, so a no-data neighbour does not poison an exact hit.
      let h = 0;
      for (const [c, r, weight] of [
        [c0, r0, (1 - tx) * (1 - ty)],
        [c0 + 1, r0, tx * (1 - ty)],
        [c0, r0 + 1, (1 - tx) * ty],
        [c0 + 1, r0 + 1, tx * ty],
      ] as const) {
        if (weight === 0) continue;
        const v = grid.values[r * grid.width + c];
        if (v === undefined || !Number.isFinite(v)) return null;
        h += v * weight;
      }
      return h;
    },
  };
}

/** A sampler over heights fetched for known points (keyed to the millimetre). */
export function terrainSamplerFromPoints(
  source: Pick<TerrainSampler, 'crs' | 'verticalCrs' | 'verticalReference' | 'verticalAccuracy'>,
  heights: ReadonlyMap<string, number | null>,
): TerrainSampler {
  return {
    crs: source.crs,
    verticalCrs: source.verticalCrs,
    verticalReference: source.verticalReference,
    verticalAccuracy: source.verticalAccuracy,
    heightAt: (p) => heights.get(pointKey(p)) ?? null,
  };
}

export function pointKey(p: MapPoint): string {
  return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
}
