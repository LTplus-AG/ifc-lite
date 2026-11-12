/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collinear merging for the drawing snap adapter (`drawing-snap.ts`).
 *
 * The section generator can deliver one straight face as several collinear
 * pieces (a 6.00 m wall face as 4.2624 m + 1.74 m). Offered as is, the split
 * vertex reads as a corner to endpoint snap and the midpoints land in the
 * middle of each piece. These helpers drop such a vertex when the pieces
 * belong to the same entity and continue in the same direction, and keep it
 * when a different entity has a vertex there (a wall meeting the face), since
 * that point is real.
 */

import type { Pt } from '../drafting-core/types';

/** Directions within this angle (radians) count as collinear. */
export const COLLINEAR_ANGLE = 1e-6;
/** Points within this distance (metres) count as one vertex. */
export const VERTEX_TOLERANCE = 1e-6;

/** Quantised vertex key; two points within VERTEX_TOLERANCE share it except across a cell edge. */
export function vertexKey(p: Pt): string {
  return `${Math.round(p.x / VERTEX_TOLERANCE)},${Math.round(p.y / VERTEX_TOLERANCE)}`;
}

/**
 * Which entities have a vertex at each point: owner key per vertex, or
 * `null` once two different owners share it.
 */
export class VertexOwners {
  private readonly owners = new Map<string, string | null>();

  add(p: Pt, owner: string): void {
    const key = vertexKey(p);
    if (!this.owners.has(key)) this.owners.set(key, owner);
    else if (this.owners.get(key) !== owner) this.owners.set(key, null);
  }

  /** True when an entity other than `owner` has a vertex at `p`. */
  sharedWithOther(p: Pt, owner: string): boolean {
    const v = this.owners.get(vertexKey(p));
    return v === null || (v !== undefined && v !== owner);
  }
}

function sameDirection(a: Pt, b: Pt, c: Pt): boolean {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu <= VERTEX_TOLERANCE || lv <= VERTEX_TOLERANCE) return false;
  const sin = (ux * vy - uy * vx) / (lu * lv);
  const cos = (ux * vx + uy * vy) / (lu * lv);
  return cos > 0 && Math.abs(sin) <= Math.sin(COLLINEAR_ANGLE);
}

/**
 * A closed ring with repeated points and same-entity collinear split
 * vertices removed. Returns the input points (copied) when fewer than three
 * would remain.
 */
export function simplifyRing(ring: readonly Pt[], owner: string, owners: VertexOwners): Pt[] {
  const pts: Pt[] = [];
  for (const p of ring) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > VERTEX_TOLERANCE) pts.push(p);
  }
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= VERTEX_TOLERANCE) pts.pop();
  }
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const next = pts[(i + 1) % pts.length];
      if (sameDirection(prev, pts[i], next) && !owners.sharedWithOther(pts[i], owner)) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts.length >= 3 ? pts : ring.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Same-entity segments with collinear pieces joined end to end. A join
 * happens only where exactly two of the entity's segments meet, they
 * continue in the same direction, and no other entity has a vertex there.
 */
export function mergeCollinearSegments(
  segments: readonly [Pt, Pt][],
  owner: string,
  owners: VertexOwners,
): [Pt, Pt][] {
  const segs: ([Pt, Pt] | null)[] = segments.map(([a, b]) => [a, b]);
  const at = new Map<string, number[]>();
  const link = (i: number, p: Pt): void => {
    const key = vertexKey(p);
    const list = at.get(key);
    if (list) list.push(i);
    else at.set(key, [i]);
  };
  const unlink = (i: number, p: Pt): void => {
    const list = at.get(vertexKey(p));
    if (!list) return;
    const k = list.indexOf(i);
    if (k >= 0) list.splice(k, 1);
  };
  segs.forEach((s, i) => {
    if (!s) return;
    link(i, s[0]);
    link(i, s[1]);
  });

  /** The far end of segment `i` as seen from vertex `key`, and its near end. */
  const ends = (i: number, key: string): { near: Pt; far: Pt } | null => {
    const s = segs[i];
    if (!s) return null;
    if (vertexKey(s[0]) === key) return { near: s[0], far: s[1] };
    if (vertexKey(s[1]) === key) return { near: s[1], far: s[0] };
    return null;
  };

  const queue = [...at.keys()];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    const list = at.get(key);
    if (!list || list.length !== 2 || list[0] === list[1]) continue;
    const [i, j] = list;
    const ei = ends(i, key);
    const ej = ends(j, key);
    if (!ei || !ej) continue;
    if (!sameDirection(ei.far, ei.near, ej.far) || owners.sharedWithOther(ei.near, owner)) continue;
    unlink(i, ei.far);
    unlink(j, ej.far);
    at.delete(key);
    segs[i] = [ei.far, ej.far];
    segs[j] = null;
    link(i, ei.far);
    link(i, ej.far);
    queue.push(vertexKey(ei.far), vertexKey(ej.far));
  }
  return segs.filter((s): s is [Pt, Pt] => s !== null);
}
