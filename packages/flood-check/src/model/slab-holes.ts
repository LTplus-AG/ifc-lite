/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a hole in a ground slab's profile is roofed by the slabs above it
 * (interior: a shaft, a stair opening, a floor area under the building) or
 * open to the sky (a courtyard). Decided over the hole's whole area.
 */

import { insideRing } from '../geom.js';
import type { MapPoint } from '../types.js';
import type { FootprintInput } from './footprint.js';
import { completeness, extrusionRegions, readSlabOutline, toWorld } from './outline.js';
import { asEnum } from './reader.js';

/**
 * Something above a ground slab that may roof a hole, in map coordinates: a
 * point is under it inside every polygon of one of its `regions` and outside
 * its `holes`. `certain` only when it was read in full (a slab's complete
 * outline with no unread voids; a roofing element whose every body leaf is a
 * plain extrusion).
 */
export interface UpperSlab {
  id: number;
  z: number;
  certain: boolean;
  regions: MapPoint[][][];
  holes: MapPoint[][];
}

/** Roofing that is not a slab: roofs, roofing coverings, windows (a skylight lying flat), plates (a glass roof). */
const ROOFING = ['IFCROOF', 'IFCCOVERING', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCPLATE', 'IFCPLATESTANDARDCASE'];

/** Every slab and roofing element of the model, mapped once (the covering test asks them for each hole). */
export function upperSlabs(input: Pick<FootprintInput, 'reader' | 'placements' | 'georef'>): UpperSlab[] {
  const { reader, placements, georef } = input;
  const out: UpperSlab[] = [];
  for (const id of [...reader.idsOfType('IFCSLAB'), ...reader.idsOfType('IFCSLABSTANDARDCASE'), ...reader.idsOfType('IFCSLABELEMENTEDCASE')]) {
    const frame = placements.ofProduct(id);
    if (!frame) continue;
    const o = readSlabOutline(reader, id);
    const map = (pts: [number, number, number][]) => toWorld(frame, pts).map((p) => ({ x: georef.toMap(p)[0], y: georef.toMap(p)[1] }));
    out.push({ id, z: georef.toMap(frame.origin)[2], certain: !o.voids && completeness(o) === 'complete', regions: o.rings.map((r) => [map(r)]), holes: o.holes.map(map) });
  }
  for (const type of ROOFING) {
    for (const id of reader.idsOfType(type)) {
      const e = reader.entity(id);
      // A covering roofs only as roofing (a ceiling or a floor finish is no roof).
      if (!e || (type === 'IFCCOVERING' && asEnum(reader.attr(e, 'PredefinedType')) !== 'ROOFING')) continue;
      const frame = placements.ofProduct(id);
      if (!frame) continue;
      const body = extrusionRegions(reader, id);
      if (body.regions.length === 0) continue;
      const map = (pts: [number, number, number][]) => toWorld(frame, pts).map((p) => georef.toMap(p));
      const regions = body.regions.map((region) => region.map(map));
      const z = Math.min(...regions.flat(2).map((p) => p[2]));
      out.push({ id, z, certain: body.complete, regions: regions.map((region) => region.map((poly) => poly.map(([x, y]) => ({ x, y })))), holes: [] });
    }
  }
  return out;
}

/**
 * Points guaranteed inside a hole: a grid clipped to it (spacing at most
 * 0.5 m, finer for a small hole) and a point just inside each edge's middle
 * and each corner, so a non-convex hole (an L, a U) is sampled over its whole
 * area, never by one representative point that may lie outside it.
 */
function pointsInside(ring: MapPoint[]): MapPoint[] {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(0.05, Math.min(0.5, (x1 - x0) / 8, (y1 - y0) / 8));
  const out: MapPoint[] = [];
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (insideRing({ x, y }, ring)) out.push({ x, y });
  const nudge = Math.min(0.02, step / 4);
  ring.forEach((a, k) => {
    const b = ring[(k + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 0)) return;
    const [nx, ny] = [(b.y - a.y) / len, -(b.x - a.x) / len];
    for (const base of [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, a]) {
      for (const sgn of [1, -1]) {
        // Towards the inside, along the normal and along the corner's diagonals.
        for (const [dx, dy] of [[nx, ny], [nx + (b.x - a.x) / len, ny + (b.y - a.y) / len], [nx - (b.x - a.x) / len, ny - (b.y - a.y) / len]]) {
          const q = { x: base.x + sgn * nudge * dx, y: base.y + sgn * nudge * dy };
          if (insideRing(q, ring)) {
            out.push(q);
            return;
          }
        }
      }
    }
  });
  return out;
}

/**
 * The slabs that roof a hole in a ground slab at `z`, or null when it is not
 * wholly roofed: every guaranteed-inside point (`pointsInside`) must be under
 * some certain slab or roofing element more than 1 m higher (`UpperSlab`),
 * outside that element's holes. One uncovered or uncertain point makes it
 * open ground. Different roofing elements may cover different parts.
 * Proven, because an interior hole stays filled and an element next to it may
 * then be excluded as interior; on doubt the hole is a courtyard.
 */
export function roofedBy(above: readonly UpperSlab[], ring: MapPoint[], z: number): number[] | null {
  const pts = pointsInside(ring);
  if (pts.length === 0) return null;
  const roofs = new Set<number>();
  for (const p of pts) {
    const roof = above.find((s) => s.certain && s.z > z + 1 && s.regions.some((region) => region.every((r) => insideRing(p, r))) && !s.holes.some((h) => insideRing(p, h)));
    if (!roof) return null;
    roofs.add(roof.id);
  }
  return [...roofs];
}
