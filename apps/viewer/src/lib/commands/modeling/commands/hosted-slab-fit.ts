/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { pointInPolygon } from '@/lib/polygon-clip';
import type { HostHit } from './hosted-host.js';
import type { Vec2 } from '@/lib/snap/types';

/** Corners alone miss a concave notch between corners. Also reject every
 * outline edge entering the rectangle's open interior (boundary contact fits). */
export function slabCutFits(host: HostHit, centre: Vec2 | null, width: number, depth: number): boolean {
  if (!centre || !host.footprint) return false;
  const polygon = [...host.footprint];
  const [x, y] = centre, w = width / 2, d = depth / 2, eps = 1e-6;
  const corners: Vec2[] = [[x-w,y-d],[x+w,y-d],[x+w,y+d],[x-w,y+d]];
  const onEdge = (p: Vec2, a: Vec2, b: Vec2) => {
    const cross = (p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]);
    return Math.abs(cross) <= eps && p[0] >= Math.min(a[0],b[0])-eps && p[0] <= Math.max(a[0],b[0])+eps
      && p[1] >= Math.min(a[1],b[1])-eps && p[1] <= Math.max(a[1],b[1])+eps;
  };
  if (!corners.every(p => pointInPolygon(polygon, p) || polygon.some((a,i) => onEdge(p,a,polygon[(i+1)%polygon.length])))) return false;
  return !polygon.some((a, i) => {
    const b = polygon[(i+1)%polygon.length];
    let lo = 0, hi = 1;
    for (const axis of [0,1] as const) {
      const min = centre[axis] - (axis === 0 ? w : d) + eps;
      const max = centre[axis] + (axis === 0 ? w : d) - eps;
      const delta = b[axis]-a[axis];
      if (Math.abs(delta) < 1e-12) { if (a[axis] <= min || a[axis] >= max) return false; }
      else {
        const t0 = (min-a[axis])/delta, t1 = (max-a[axis])/delta;
        lo = Math.max(lo, Math.min(t0,t1)); hi = Math.min(hi, Math.max(t0,t1));
      }
    }
    return lo < hi;
  });
}
