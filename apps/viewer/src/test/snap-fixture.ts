/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Test-only helpers for the snap engine suites (seeded RNG, a scene source, query builder). */

import type { SnapCandidate, SnapQuery, SnapSource, Vec2 } from '@/lib/snap/types.js';

/** mulberry32: small, seedable, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}

/**
 * A plain scene source: `points` as vertices, each segment's ends as endpoints
 * and its body as an edge (closest point to the cursor, segment guide).
 * Over-collects on purpose (the solver owns the radius).
 */
export function sceneSource(
  points: readonly Vec2[],
  segments: readonly (readonly [Vec2, Vec2])[],
  id = 'linework',
): SnapSource {
  return {
    id,
    collect(q: SnapQuery, _radius: number, out: SnapCandidate[]): void {
      for (const p of points) out.push({ kind: 'vertex', local: p, source: 'linework' });
      for (const [a, b] of segments) {
        out.push({ kind: 'endpoint', local: a, source: 'linework' });
        out.push({ kind: 'endpoint', local: b, source: 'linework' });
      }
      for (const [a, b] of segments) {
        out.push({
          kind: 'edge', local: closestOnSegment(q.cursor, a, b), source: 'linework',
          guide: { kind: 'segment', a, b, role: 'edge' },
        });
      }
    },
  };
}

export function query(cursor: Vec2, extra: Partial<SnapQuery> = {}): SnapQuery {
  return {
    cursor,
    metresPerPixel: 0.01,
    anchor: null,
    chain: [],
    modifiers: { shift: false, alt: false },
    locks: {},
    ...extra,
  };
}
