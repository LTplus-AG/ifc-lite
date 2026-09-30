/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a storey already has rooms (charter #6232 M4): the Room tool must not
 * lay a second IfcSpace over one that exists.
 *
 * Two sources, because neither sees every space:
 *   - the rendered IfcSpace meshes, as plan triangles — exact for any body a
 *     file space has (AC20's are triangulated face sets, whose footprint
 *     `existingSpaceFootprintsByStorey` returns as an UNORDERED vertex cloud,
 *     not a ring: a point-in-polygon test on it misses rooms that exist);
 *   - the footprint rings `existingSpaceFootprintsByStorey` reads from the
 *     IFC, kept only when they are simple polygons (an extruded profile, such
 *     as every room this tool writes, whose mesh may not have landed yet).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { pointInPoly, type Pt } from '@/lib/rooms/plate-geometry';

type Tri = [Pt, Pt, Pt];

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

function inTriangle(p: Pt, [a, b, c]: Tri): boolean {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * The plan triangles of the IfcSpace meshes whose height range overlaps the
 * render-Y band `[lo, hi]`. `toPlan` maps a render-frame vertex to the plan
 * frame the rooms are in; `live` drops meshes of deleted spaces.
 */
export function spaceMeshTriangles(
  meshes: readonly MeshData[],
  band: { lo: number; hi: number },
  toPlan: (x: number, y: number, z: number) => Pt,
  live: (mesh: MeshData) => boolean,
): Tri[] {
  const out: Tri[] = [];
  for (const mesh of meshes) {
    if (mesh.ifcType !== 'IfcSpace' || !live(mesh)) continue;
    const pos = mesh.positions;
    const o = mesh.origin ?? [0, 0, 0];
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const y = o[1] + pos[i];
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    if (!(ymax > band.lo && ymin < band.hi)) continue;
    const at = (v: number): Pt => toPlan(o[0] + pos[v * 3], o[1] + pos[v * 3 + 1], o[2] + pos[v * 3 + 2]);
    const idx = mesh.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const tri: Tri = [at(idx[t]), at(idx[t + 1]), at(idx[t + 2])];
      // Walls of the volume project to slivers; only its floor and ceiling cover plan area.
      if (Math.abs(cross(tri[0], tri[1], tri[2])) > 1e-9) out.push(tri);
    }
  }
  return out;
}

/** Whether a plan point lies in a room that already exists. */
export function occupancyTest(rings: readonly Pt[][], triangles: readonly Tri[]): (p: Pt) => boolean {
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
