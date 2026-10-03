/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IFC authoring parameters for a floor and one or two planar ceiling faces (#6686).
 * The Rust mesher evaluates the emitted IFC clipping solids. Heights and footprint
 * coordinates here are storey-local metres. No mesh is used as an editable source. */
import { isSimpleRing } from './room-occupancy';
import type { Vec2 } from '@/lib/snap/types';
import { clipPolygonByLine, type Point2D } from '@/lib/polygon-clip';
import { signedArea2, triangulateOutline } from '@/lib/commands/modeling/ghost-shapes';

/** z = x*a + y*b + c, in storey-local metres. */
export interface CeilingPlane { a: number; b: number; c: number }
export interface SpaceEnvelope { floor: number; ceiling: readonly CeilingPlane[] }
export interface EnvelopeSection {
  /** Horizontal unit direction of the section in storey XY. */
  direction: Vec2;
  /** Absolute horizontal coordinates along direction, with eaves / optional ridge elevations. */
  points: readonly Vec2[];
  floor: number;
}

export const ceilingAt = (planes: readonly CeilingPlane[], p: Vec2): number =>
  Math.min(...planes.map(({ a, b, c }) => a * p[0] + b * p[1] + c));

export function sectionEnvelope(section: EnvelopeSection): SpaceEnvelope | null {
  const { direction: [dx, dy], points, floor } = section;
  if (![dx, dy, floor, ...points.flat()].every(Number.isFinite)
    || Math.abs(Math.hypot(dx, dy) - 1) > 1e-6 || (points.length !== 2 && points.length !== 3)) return null;
  const ceiling: CeilingPlane[] = [];
  for (let i = 1; i < points.length; i++) {
    const [u0, z0] = points[i - 1], [u1, z1] = points[i];
    if (u1 - u0 < 0.01 - 1e-9) return null;
    const slope = (z1 - z0) / (u1 - u0);
    ceiling.push({ a: slope * dx, b: slope * dy, c: z0 - slope * u0 });
  }
  // A pitched ceiling is the intersection of two upper half-spaces. A valley
  // would require a union; never silently turn it into an inverted ridge.
  if (ceiling.length === 2 && (points[1][1] - points[0][1]) / (points[1][0] - points[0][0])
    < (points[2][1] - points[1][1]) / (points[2][0] - points[1][0]) - 1e-9) return null;
  return { floor, ceiling };
}

/** Partition triangles at the ridge, so the integral of the minimum of two
 * affine ceilings is exact even over a concave footprint. */
export function envelopeMeasures(outline: readonly Vec2[], envelope: SpaceEnvelope): { area: number; volume: number; height: number } | null {
  if (outline.length < 3 || outline.length > 256 || !outline.flat().every(Number.isFinite)
    || !Number.isFinite(envelope.floor) || ![1, 2].includes(envelope.ceiling.length)
    || !envelope.ceiling.every(p => [p.a, p.b, p.c].every(Number.isFinite) && Math.hypot(p.a, p.b, 1) <= 1e6)) return null;
  if (!isSimpleRing(outline.map(([x, y]) => [x, y]))) return null;
  const heights = outline.map(p => ceilingAt(envelope.ceiling, p) - envelope.floor);
  if (heights.some(h => h < 0.01)) return null;
  const area = Math.abs(signedArea2(outline)) / 2;
  if (area < 1e-6) return null;
  let volume = 0, height = 0;
  for (const tri of triangulateOutline(outline)) {
    const polygon: Point2D[] = tri.map(i => [...outline[i]]);
    let parts = [polygon];
    if (envelope.ceiling.length === 2) {
      const [p, q] = envelope.ceiling;
      const a = p.a - q.a, b = p.b - q.b, c = p.c - q.c;
      const l2 = a * a + b * b;
      if (l2 > 1e-18) {
        const at: Point2D = [-a * c / l2, -b * c / l2];
        const cut = clipPolygonByLine(polygon, at, [at[0] - b, at[1] + a]);
        if (cut.ok) parts = [cut.left, cut.right];
      }
    }
    for (const part of parts) {
      // Each part is convex (a clipped triangle); fan triangulation is exact.
      for (let j = 1; j + 1 < part.length; j++) {
        const vertices = [part[0], part[j], part[j + 1]];
        const hs = vertices.map(p => ceilingAt(envelope.ceiling, p) - envelope.floor);
        volume += Math.abs(signedArea2(vertices)) / 2 * (hs[0] + hs[1] + hs[2]) / 3;
        height = Math.max(height, ...hs);
      }
    }
  }
  return Number.isFinite(volume) && volume > 0 ? { area, volume, height } : null;
}
