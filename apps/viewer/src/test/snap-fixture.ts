/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Test-only helpers for the snap engine suites (seeded RNG, a scene source, query builder). */

import { createLineworkSource } from '@/lib/snap/sources/linework.js';
import type { SnapQuery, SnapSource, Vec2 } from '@/lib/snap/types.js';

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

/** A plain scene source: `points` as vertices, segments as endpoints + edges (inference-aware). */
export function sceneSource(
  points: readonly Vec2[],
  segments: readonly (readonly [Vec2, Vec2])[],
  id = 'linework',
): SnapSource {
  return createLineworkSource({ vertices: points, segments, inference: true }, id);
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
