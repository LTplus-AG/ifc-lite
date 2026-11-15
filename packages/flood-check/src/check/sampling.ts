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
  if (d <= 0) {
    const nearest = closestBoundaryPoint(candidate.position, rings);
    if (nearest) {
      anchor = nearest.point;
      anchorBasis = 'nearest-outline-point';
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
  return { anchor, anchorBasis, points, rejected };
}

/** What a raster says at a point. */
export type CellReading = { kind: 'class'; code: number } | { kind: 'no-runoff' } | { kind: 'unclassified' } | { kind: 'outside' };

export function readCell(raster: ClassifiedHazardRaster, p: MapPoint): CellReading {
  const col = Math.floor((p.x - raster.origin.x) / raster.cellSize);
  const row = Math.floor((raster.origin.y - p.y) / raster.cellSize);
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return { kind: 'outside' };
  const code = raster.cells[row * raster.width + col];
  if (code === CELL_NO_RUNOFF) return { kind: 'no-runoff' };
  if (code === CELL_UNCLASSIFIED || code > raster.classes.length) return { kind: 'unclassified' };
  return { kind: 'class', code };
}

/** Bilinear interpolation between cell centres of a terrain grid; null outside it or next to no-data. */
export function terrainSamplerFromGrid(grid: TerrainGrid): TerrainSampler {
  return {
    crs: grid.crs,
    verticalReference: grid.verticalReference,
    heightAt(p: MapPoint): number | null {
      const fx = (p.x - grid.origin.x) / grid.cellSize - 0.5;
      const fy = (grid.origin.y - p.y) / grid.cellSize - 0.5;
      const c0 = Math.floor(fx);
      const r0 = Math.floor(fy);
      const tx = fx - c0;
      const ty = fy - r0;
      const at = (c: number, r: number): number => {
        const cc = Math.min(Math.max(c, 0), grid.width - 1);
        const rr = Math.min(Math.max(r, 0), grid.height - 1);
        return grid.heights[rr * grid.width + cc];
      };
      if (fx < -0.5 || fy < -0.5 || fx > grid.width - 0.5 || fy > grid.height - 0.5) return null;
      // Only cells with a non-zero weight count, so a no-data neighbour does not poison an exact hit.
      let h = 0;
      for (const [c, r, weight] of [
        [c0, r0, (1 - tx) * (1 - ty)],
        [c0 + 1, r0, tx * (1 - ty)],
        [c0, r0 + 1, (1 - tx) * ty],
        [c0 + 1, r0 + 1, tx * ty],
      ] as const) {
        if (weight === 0) continue;
        const v = at(c, r);
        if (!Number.isFinite(v)) return null;
        h += v * weight;
      }
      return h;
    },
  };
}

/** A sampler over heights fetched for known points (keyed to the millimetre). */
export function terrainSamplerFromPoints(
  crs: string,
  verticalReference: string,
  heights: ReadonlyMap<string, number | null>,
): TerrainSampler {
  return {
    crs,
    verticalReference,
    heightAt: (p) => heights.get(pointKey(p)) ?? null,
  };
}

export function pointKey(p: MapPoint): string {
  return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
}
