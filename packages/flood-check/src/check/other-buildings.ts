/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Other buildings' footprints, validated before any of them may prove open
 * ground. A ring that cannot be a building outline (fewer than 3 finite
 * points, no area, a repeated vertex, entirely outside the stated extent: for
 * example x and y swapped) makes the source not complete, because the
 * building it was meant to describe is then missing. `complete` covers only
 * the stated `extent`: a transparent sample outside it proves nothing.
 */

import { closestBoundaryPoint, insideRing, ringArea } from '../geom.js';
import type { MapBBox, MapPoint, OtherBuildingFootprints } from '../types.js';

export interface ResolvedOtherBuildings {
  /** The valid rings. */
  rings: MapPoint[][];
  /** The source said complete, its extent is valid and every ring is valid. */
  complete: boolean;
  extent: MapBBox | null;
  /** Why rings or the extent were rejected (one line each). */
  rejected: string[];
}

const finite = (p: MapPoint | undefined): p is MapPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function ringProblem(ring: readonly MapPoint[] | undefined, extent: MapBBox | null): string | null {
  if (!Array.isArray(ring)) return 'not a list of points';
  if (!ring.every(finite)) return 'a point is not finite';
  const pts = ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return `${pts.length} distinct point(s), fewer than 3`;
  const seen = new Set<string>();
  for (const p of pts) {
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) return 'a vertex repeats (a ring listed twice reads as outside everywhere)';
    seen.add(key);
  }
  if (!(ringArea(pts) > 0.01)) return 'it encloses no area';
  if (extent) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    if (Math.max(...xs) < extent.minX || Math.min(...xs) > extent.maxX || Math.max(...ys) < extent.minY || Math.min(...ys) > extent.maxY) {
      return 'it lies wholly outside the stated extent (coordinates swapped or in another system?)';
    }
  }
  return null;
}

export function resolveOtherBuildings(o: OtherBuildingFootprints): ResolvedOtherBuildings {
  const rejected: string[] = [];
  const e = o.extent;
  const extentOk = !!e && [e.minX, e.minY, e.maxX, e.maxY].every(Number.isFinite) && e.minX < e.maxX && e.minY < e.maxY;
  if (!extentOk) rejected.push('the extent is missing or not a valid box');
  const extent = extentOk ? e : null;
  const rings: MapPoint[][] = [];
  (Array.isArray(o.rings) ? o.rings : []).forEach((ring, i) => {
    const problem = ringProblem(ring, extent);
    if (problem) rejected.push(`ring ${i}: ${problem}`);
    else rings.push(ring);
  });
  if (!Array.isArray(o.rings)) rejected.push('rings is not a list');
  return { rings, complete: o.complete === true && rejected.length === 0, extent, rejected };
}

export function insideExtent(p: MapPoint, e: MapBBox | null): boolean {
  return !!e && p.x >= e.minX && p.x <= e.maxX && p.y >= e.minY && p.y <= e.maxY;
}

/**
 * Inside another building, its boundary included: the even-odd test leaves a
 * point on a ring's north or east edge outside, yet the raster cell it reads
 * there is the building's own (raised, transparent).
 */
export function insideOtherBuilding(p: MapPoint, rings: readonly (readonly MapPoint[])[]): boolean {
  return rings.some((ring) => insideRing(p, ring)) || (closestBoundaryPoint(p, rings)?.distance ?? Infinity) <= 1e-6;
}
