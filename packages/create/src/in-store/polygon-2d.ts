/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The one home of the plan-polygon primitives every builder and room tool
 * measures with. Rings are simple and do not repeat their first point. */

export type PolygonRing = ReadonlyArray<readonly [number, number]>;

/** Absolute shoelace area, in the square of the ring's unit. */
export function polygonArea(ring: PolygonRing): number {
  let doubled = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    doubled += ax * by - bx * ay;
  }
  return Math.abs(doubled) / 2;
}

/** Even-odd ray cast; a ring of fewer than three points contains nothing. */
export function pointInPolygon(x: number, y: number, ring: PolygonRing): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
