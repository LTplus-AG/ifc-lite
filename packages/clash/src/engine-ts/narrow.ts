/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, ClashElement, ClashRule, ClashStatus, Vec3 } from '../types.js';
import { aabbContains, boundsOfPoints, center, inflate, overlapBounds, signedGap } from '../math/aabb.js';
import { centroid, mid } from '../math/vec3.js';
import { triTriIntersect } from '../math/triangle-intersect.js';
import { triTriDistance } from '../math/triangle-distance.js';
import type { TriMesh } from './tri-mesh.js';

export interface NarrowResult {
  status: ClashStatus;
  distance: number;
  point: Vec3;
  bounds: AABB;
}

/**
 * Narrow-phase test for one candidate element pair.
 *
 * Gathers candidate triangle pairs through the per-element triangle BVHs (work
 * stays proportional to actual overlap — no decimation), then:
 * - a genuine non-coplanar triangle crossing ⇒ `hard` (pipe through beam, etc.);
 * - surfaces that merely coincide/touch (no crossing) are disambiguated by AABB
 *   penetration, so a deep axis-aligned overlap — whose surface intersections
 *   are all coplanar — is still classified `hard`, while face contact is `touch`;
 * - otherwise the exact triangle distance drives `clearance` / `touch` / no clash.
 *
 * Returns `null` for no clash.
 */
export function testPair(
  elA: ClashElement,
  triA: TriMesh,
  elB: ClashElement,
  triB: TriMesh,
  rule: ClashRule,
  tolerance: number,
): NarrowResult | null {
  const margin = Math.max(tolerance, rule.clearance ?? 0);

  // Iterate the smaller mesh, querying the larger one's BVH.
  const aSmaller = triA.count <= triB.count;
  const small = aSmaller ? triA : triB;
  const large = aSmaller ? triB : triA;

  let intersects = false;
  let contactSumX = 0;
  let contactSumY = 0;
  let contactSumZ = 0;
  let contactN = 0;
  let minDist = Infinity;
  let closestA: Vec3 = elA.bounds.min as Vec3;
  let closestB: Vec3 = elB.bounds.min as Vec3;

  for (let ts = 0; ts < small.count; ts += 1) {
    const sb = small.triBounds(ts);
    const hits = large.queryTris(inflate(sb, margin));
    if (hits.length === 0) continue;
    const [s0, s1, s2] = small.tri(ts);
    for (const tl of hits) {
      const [l0, l1, l2] = large.tri(tl);
      if (triTriIntersect(s0, s1, s2, l0, l1, l2)) {
        intersects = true;
        const c = mid(centroid(s0, s1, s2), centroid(l0, l1, l2));
        contactSumX += c[0];
        contactSumY += c[1];
        contactSumZ += c[2];
        contactN += 1;
      } else if (!intersects) {
        // Distance only matters while we still might be a clearance/touch case.
        const d = triTriDistance(s0, s1, s2, l0, l1, l2);
        if (d.dist < minDist) {
          minDist = d.dist;
          closestA = d.pA;
          closestB = d.pB;
        }
      }
    }
  }

  const overlap = overlapBounds(elA.bounds, elB.bounds);

  if (intersects) {
    const point: Vec3 = contactN > 0
      ? [contactSumX / contactN, contactSumY / contactN, contactSumZ / contactN]
      : center(overlap);
    // Phase-0 penetration estimate from AABB overlap; exact depth lands in Rust.
    const penetration = Math.max(0, -signedGap(elA.bounds, elB.bounds));
    return { status: 'hard', distance: -penetration, point, bounds: overlap };
  }

  // Fully-enclosed solid: no surface crossing, but one element's AABB is wholly
  // inside the other's, so it may be buried (e.g. equipment inside a slab). With
  // no surface crossing the inner solid is entirely inside OR entirely outside
  // the other, so ray-casting ONE representative vertex of the contained mesh
  // against the other solid decides it — and ray casting (not an AABB test)
  // correctly returns "outside" when the inner sits in a concave notch.
  // Test B-contains-A first, then A-contains-B, so the inner pick is
  // deterministic (and identical to the Rust kernel) on equal AABBs.
  if (aabbContains(elB.bounds, elA.bounds)) {
    if (triA.count > 0 && triB.containsPoint(triA.tri(0)[0])) {
      return { status: 'hard', distance: signedGap(elA.bounds, elB.bounds), point: center(overlap), bounds: overlap };
    }
  } else if (aabbContains(elA.bounds, elB.bounds)) {
    if (triB.count > 0 && triA.containsPoint(triB.tri(0)[0])) {
      return { status: 'hard', distance: signedGap(elA.bounds, elB.bounds), point: center(overlap), bounds: overlap };
    }
  }

  if (minDist === Infinity) {
    // Broad-phase candidate with no triangle-level proximity — not a clash.
    return null;
  }

  // Surfaces coincide/touch with no genuine crossing, but the volumes overlap
  // beyond tolerance (e.g. axis-aligned boxes, whose surface intersections are
  // all coplanar) -> hard, via AABB penetration depth.
  if (minDist <= tolerance) {
    const gap = signedGap(elA.bounds, elB.bounds);
    if (gap < -tolerance) {
      return { status: 'hard', distance: gap, point: center(overlap), bounds: overlap };
    }
  }

  // Clearance rule: ANY gap within the required clearance is a violation —
  // including sub-tolerance, nearly-touching gaps, which are the MOST severe and
  // must not be swallowed by the touch band below.
  if (rule.mode === 'clearance' && rule.clearance != null && minDist <= rule.clearance) {
    return {
      status: 'clearance',
      distance: minDist,
      point: mid(closestA, closestB),
      bounds: boundsOfPoints(closestA, closestB),
    };
  }

  // Otherwise only bare contact within tolerance remains; suppressed unless the
  // rule opts in. `<=` so an exact touch at tolerance 0 is still caught.
  if (minDist <= tolerance) {
    if (!rule.reportTouch) return null;
    return {
      status: 'touch',
      distance: minDist,
      point: mid(closestA, closestB),
      bounds: boundsOfPoints(closestA, closestB),
    };
  }

  return null;
}
