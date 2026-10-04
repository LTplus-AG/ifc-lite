/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure candidate/link/occupancy policy shared by native Room hosts (#6232 D5). */
import type { SpaceFootprint } from './space-footprints.js';
import { polygonArea as polyArea, pointInPolygon as pointInPoly } from './room-footprint-offset.js';
import type { LayoutFace, Pt } from './room-layout-core.js';
export type RoomTriangle = [Pt, Pt, Pt];
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A ring whose non-adjacent edges never cross: a polygon, not a point cloud. */
export function isSimpleRing(ring: readonly Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

function inTriangle(p: Pt, [a, b, c]: RoomTriangle): boolean {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Whether a plan point lies in a room that already exists. */
export function occupancyTest(rings: readonly Pt[][], triangles: readonly RoomTriangle[]): (p: Pt) => boolean {
  const polygons = rings.filter(isSimpleRing);
  return (p) => polygons.some((ring) => pointInPoly(p[0], p[1], ring)) || triangles.some((tri) => inTriangle(p, tri));
}

/** The existing room a layout face is, and which wall face its outline follows. */
export interface RoomLink {
  expressId: number;
  boundary: 'inner' | 'center' | 'outer';
}

/** How far a room's area may be from its face's to still be that face's room. */
const LINK_AREA_RATIO = 0.25;

const ringArea = (ring: readonly Pt[]): number => {
  let a = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; });
  return Math.abs(a) / 2;
};

/**
 * Which existing room each layout face is: a room whose footprint holds the
 * face's interior point AND whose area matches one of the face's three
 * outlines (inner, axis, outer) to within `LINK_AREA_RATIO` — the outline it
 * was written with. A room over several faces (one over the whole storey)
 * matches none of them and links nowhere; a room links to one face at most,
 * the closest match. Faces are `{ face, interior, inner, centre, outer }`.
 */
export function linkFaces(
  faces: readonly { face: number; interior: Pt; inner: Pt[]; centre: Pt[]; outer: Pt[] }[],
  spaces: readonly { expressId: number; footprint: Pt[] }[],
): Map<number, RoomLink> {
  const best = new Map<number, { face: number; boundary: RoomLink['boundary']; err: number }>();
  for (const f of faces) {
    for (const space of spaces) {
      if (!isSimpleRing(space.footprint) || !pointInPoly(f.interior[0], f.interior[1], space.footprint)) continue;
      const area = ringArea(space.footprint);
      for (const boundary of ['inner', 'center', 'outer'] as const) {
        const faceArea = ringArea(boundary === 'inner' ? f.inner : boundary === 'outer' ? f.outer : f.centre);
        const err = Math.abs(area - faceArea) / Math.max(faceArea, 1e-9);
        const held = best.get(space.expressId);
        if (err <= LINK_AREA_RATIO && (!held || err < held.err)) best.set(space.expressId, { face: f.face, boundary, err });
      }
    }
  }
  const links = new Map<number, RoomLink & { err: number }>();
  for (const [expressId, { face, boundary, err }] of best) {
    const held = links.get(face);
    if (!held || err < held.err) links.set(face, { expressId, boundary, err });
  }
  return new Map([...links].map(([face, { expressId, boundary }]) => [face, { expressId, boundary }]));
}
/** Which wall face a room's outline follows: the room side, the axis, the far side. */
export type RoomBoundary = 'inner' | 'center' | 'outer';

export interface RoomCandidate extends LayoutFace {
  /** Centreline area: the gross floor area. */
  grossArea: number;
  /** Inner-face area: the net floor area. */
  netArea: number;
  /** A point inside the face, for labels and the "already a room" test. */
  interior: Pt;
  /** An IfcSpace on the storey already covers this face. */
  taken: boolean;
  /** The existing room this face is (its outline), which layout edits reshape. */
  room: RoomLink | null;
}

/** The outline a room is written with at `boundary`. */
export function roomOutline(room: LayoutFace, boundary: RoomBoundary): Pt[] {
  return boundary === 'inner' ? room.inner : boundary === 'outer' ? room.outer : room.centre;
}

/**
 * A point strictly inside `poly`: its vertex centroid when that is inside (a
 * convex or mildly concave room), else the middle of the widest span of the
 * horizontal line through it (an L- or U-shaped room).
 */
export function interiorPoint(poly: readonly Pt[]): Pt {
  const n = poly.length;
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  const ring = poly as Pt[];
  if (pointInPoly(cx, cy, ring)) return [cx, cy];
  const xs: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > cy) !== (yj > cy)) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best: Pt = [cx, cy], width = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1] - xs[k] > width) { width = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, cy]; }
  }
  return best;
}

/** The smallest room whose centreline outline holds `p` (a room nested in another wins). */
export function roomAt<R extends RoomCandidate>(rooms: readonly R[], p: readonly [number, number]): R | null {
  let hit: R | null = null;
  for (const room of rooms) {
    if (pointInPoly(p[0], p[1], room.centre) && (!hit || room.grossArea < hit.grossArea)) hit = room;
  }
  return hit;
}

/** Layout faces → candidate rooms, `taken` where `occupied`, linked to the `spaces` they are. */
export function roomCandidatesFromFaces(
  faces: readonly LayoutFace[],
  occupied: (p: Pt) => boolean = () => false,
  spaces: readonly SpaceFootprint[] = [],
): RoomCandidate[] {
  const withInterior = faces.map((face) => ({ ...face, interior: interiorPoint(face.inner.length >= 3 ? face.inner : face.centre) }));
  const links = linkFaces(withInterior, spaces as { expressId: number; footprint: Pt[] }[]);
  return withInterior.map((face) => {
    const room = links.get(face.face) ?? null;
    return {
      ...face,
      grossArea: polyArea(face.centre),
      netArea: polyArea(face.inner),
      taken: room !== null || occupied(face.interior),
      room,
    };
  });
}
