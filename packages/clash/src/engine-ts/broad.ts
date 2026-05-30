/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BVH, type MeshWithBounds } from '@ifc-lite/spatial';
import type { ClashElement } from '../types.js';
import { inflate } from '../math/aabb.js';

/**
 * Broad-phase candidate pairs.
 *
 * Group pair (`groupB` provided): each returned `[i, j]` indexes
 * `groupA[i]` × `groupB[j]`. Self-clash (`groupB === null`): both indices refer
 * to `groupA`, with `i < j`. Query bounds are inflated by `margin` so clearance
 * candidates (within the gap) are not missed.
 */
export function candidatePairs(
  groupA: ClashElement[],
  groupB: ClashElement[] | null,
  margin: number,
): Array<[number, number]> {
  if (groupA.length === 0) return [];

  const items: MeshWithBounds[] = groupA.map((e, i) => ({ bounds: e.bounds, expressId: i }));
  const bvh = BVH.build(items);
  const pairs: Array<[number, number]> = [];

  if (groupB) {
    const seen = new Set<string>();
    for (let j = 0; j < groupB.length; j += 1) {
      const b = groupB[j];
      const hits = bvh.queryAABB(inflate(b.bounds, margin));
      for (const i of hits) {
        const a = groupA[i];
        if (a.key === b.key && a.model === b.model) continue;
        const dedup = orderKey(a.model, a.key, b.model, b.key);
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        pairs.push([i, j]);
      }
    }
  } else {
    for (let i = 0; i < groupA.length; i += 1) {
      const hits = bvh.queryAABB(inflate(groupA[i].bounds, margin));
      for (const j of hits) {
        if (j <= i) continue;
        pairs.push([i, j]);
      }
    }
  }

  return pairs;
}

function orderKey(modelA: string, keyA: string, modelB: string, keyB: string): string {
  const a = `${modelA} ${keyA}`;
  const b = `${modelB} ${keyB}`;
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}
