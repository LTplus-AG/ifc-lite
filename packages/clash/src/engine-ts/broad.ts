/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameClashObject } from '../object-identity.js';
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
    // No entity-identity dedup here. Deduping candidate PAIRS by
    // (a.model, a.key, b.model, b.key) before the narrow phase ran used to
    // collapse every sub-prim of a split entity onto whichever one the BVH
    // reached first — so a broad-phase false positive submesh could claim
    // the (A, B) slot and hide a sibling submesh that genuinely clashes
    // (#5194). Every candidate the broad phase finds is now tested; entity
    // identity is deduped once, downstream, AFTER the narrow phase has
    // decided each submesh's verdict, keeping the more severe one — see
    // `mostSevere` in `orchestrator.ts`, where both kernels' records converge.
    // Its pair identity preserves durable keys and disambiguates repeated
    // GlobalIds by object reference (#9259).
    for (let j = 0; j < groupB.length; j += 1) {
      const b = groupB[j];
      const hits = bvh.queryAABB(inflate(b.bounds, margin));
      for (const i of hits) {
        const a = groupA[i];
        if (sameClashObject(a, b)) continue;
        pairs.push([i, j]);
      }
    }
  } else {
    for (let i = 0; i < groupA.length; i += 1) {
      const a = groupA[i];
      const hits = bvh.queryAABB(inflate(a.bounds, margin));
      for (const j of hits) {
        if (j <= i) continue;
        const other = groupA[j];
        // Skip same-entity pairs: an element split across several geometry
        // sub-prims (common in IFC5/USD) produces multiple elements with the
        // same model/ref — that is one entity, not a self-clash.
        if (sameClashObject(a, other)) continue;
        pairs.push([i, j]);
      }
    }
  }

  return pairs;
}
