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

import { closestOutlinePoint, nearestRing, outsideBy, signedDistance, type PreparedFootprint } from '../region.js';
import type { CandidateFact } from '../model/facts.js';
import {
  CELL_NO_RUNOFF,
  CELL_UNCLASSIFIED,
  type ClassifiedHazardRaster,
  type MapPoint,
  type TerrainGrid,
  type TerrainSampler,
} from '../types.js';

/**
 * The sampling geometry. Fixed, not caller options: fewer directions, other
 * rings or a larger distance from the footprint can each drop the sample that
 * shows a class, which would make an outcome more favourable without any new
 * information. The values are recorded in every result.
 */
export interface ResolvedSampling {
  ringDistances: readonly number[];
  directions: number;
  minOutsideDistance: number;
  /** Outward offset of the terrain samples taken along the footprint outline for the building-level height test, metres. */
  outlineOffset: number;
  /** Largest spacing of those outline samples, metres. */
  outlineSpacing: number;
}

export function resolveSampling(): ResolvedSampling {
  return { ringDistances: [2, 3], directions: 16, minOutsideDistance: 1, outlineOffset: 2, outlineSpacing: 2 };
}

/**
 * Terrain sample points along the whole footprint outline, `outlineOffset`
 * outside it, at most `outlineSpacing` apart (wider for a very long outline,
 * so at most 400 points). The building-level height test reads these, so it
 * sees the uphill and the downhill side of the building whichever side the
 * candidate elements are on.
 */
export function outlineTerrainPoints(fp: PreparedFootprint, s: ResolvedSampling): MapPoint[] {
  const rings = fp.rings;
  let perimeter = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  const spacing = Math.max(s.outlineSpacing, perimeter / 400);
  const out: MapPoint[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0)) continue;
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      const steps = Math.max(1, Math.ceil(len / spacing));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const m = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        for (const sign of [1, -1]) {
          const p = { x: m.x + sign * nx * s.outlineOffset, y: m.y + sign * ny * s.outlineOffset };
          // No footprint (null): nothing excludes a point; the footprint quality then withholds every favourable outcome.
          if (outsideBy(fp, p, s.minOutsideDistance) !== false) {
            out.push(p);
            break;
          }
        }
      }
    }
  }
  return out;
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
  /** The anchor was taken on, or the nearest footprint boundary is, a courtyard ring (one the footprint fills). */
  nearestBoundaryNested: boolean;
}


/** Plan the samples of one candidate on the prepared footprint (`region.ts`: prepared once per check, from the facts as they are). */
export function planSamples(candidate: CandidateFact, fp: PreparedFootprint, s: ResolvedSampling): SamplePlan {
  const near = nearestRing(fp, candidate.position);
  let anchorRing = near;
  // The same footprint as every other question: inside (a seam, a gap too narrow to be open ground, a ring) moves the
  // anchor to the real outline, and the anchor-offset guard sees how far; a courtyard is open ground.
  const d = signedDistance(fp, candidate.position);
  let anchor = candidate.position;
  let anchorBasis: SamplePlan['anchorBasis'] = 'element';
  let anchorOffset = 0;
  // No footprint (null): nothing to move to; the element is its own anchor.
  if (d !== null && d <= 0) {
    const nearest = closestOutlinePoint(fp, candidate.position);
    if (nearest) {
      anchor = nearest.point;
      anchorBasis = 'nearest-outline-point';
      anchorOffset = nearest.distance;
      anchorRing = nearest.ring;
    }
  }
  const points: SamplePlan['points'] = [];
  let rejected = 0;
  for (const ring of s.ringDistances) {
    for (let k = 0; k < s.directions; k++) {
      const a = (2 * Math.PI * k) / s.directions;
      const p = { x: anchor.x + ring * Math.cos(a), y: anchor.y + ring * Math.sin(a) };
      // No footprint (null): every ring point is taken; nothing is known to be inside, and the footprint withholds.
      if (outsideBy(fp, p, s.minOutsideDistance) !== false) points.push({ point: p, ring });
      else rejected++;
    }
  }
  return { anchor, anchorBasis, anchorOffset, points, rejected, nearestBoundaryNested: [near, anchorRing].some((r) => r !== undefined && fp.courtyards.has(r)) };
}

/** What a raster says at a point. `outside-coverage`: outside (or too near) the perimeter the map covers. */
export type CellReading =
  | { kind: 'class'; code: number }
  | { kind: 'no-runoff' }
  | { kind: 'unclassified' }
  | { kind: 'outside' }
  | { kind: 'outside-coverage' };

export function readCell(raster: ClassifiedHazardRaster, p: MapPoint): CellReading {
  // The raster carries its own coverage (required): outside it, or too near its perimeter, transparent means no data.
  if (raster.covers !== 'everywhere' && raster.covers(p) !== true) return { kind: 'outside-coverage' };
  // Cell (col, row) covers [x0 + col*c, x0 + (col+1)*c) in x and (y0 - (row+1)*c, y0 - row*c] in y (types.ts):
  // each cell is closed at its north edge, so a point on a row boundary is the north edge of the row SOUTH of it,
  // and floor((y0 - y) / c) is that row.
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
