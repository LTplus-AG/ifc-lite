/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Iterated mutual-nearest-neighbour pairing between two sets of points.
 *
 * Used by the content-keyed matching pass for the leftover N:M candidates in a
 * bucket: entities that already agree on `ifcType` and `dataHash`, so the only
 * open question is which one became which.
 *
 * Two alternatives were rejected on purpose:
 *
 * - **Greedy nearest-centroid** is order-dependent — the answer changes with
 *   the order the caller happened to enumerate entities in — and it commits to
 *   a bad chain: one early pairing at the cap edge can displace every later
 *   one.
 * - **Hungarian / optimal assignment** minimises the *total* distance, which
 *   is the wrong objective here. It pairs everything it is given, including
 *   elements that genuinely appeared or disappeared, and it will accept a pair
 *   sitting at the distance cap to buy a shorter pairing elsewhere. A global
 *   optimum over the candidates is not evidence that two entities are the same
 *   entity.
 *
 * Mutual nearest neighbour is deterministic, order-independent, and abstains
 * by construction: a symmetric layout of identical elements that all moved has
 * no unique nearest neighbour anywhere, and reporting that as ambiguous is the
 * correct answer, not a failure.
 */

import { centreDistance, type Vec3 } from './geometry-compare.js';

export interface NearestPair {
  /** Index into the `base` array passed to {@link mutualNearestPairs}. */
  base: number;
  /** Index into the `head` array passed to {@link mutualNearestPairs}. */
  head: number;
  /** Centre distance between the two, unclamped. */
  distance: number;
}

/**
 * For every unretired point in `from`, the index of its *unique* nearest
 * unretired point in `to`, or -1 when there is none or the nearest is tied.
 *
 * A tie is an abstention, not a coin flip: two candidates equidistant from the
 * same element carry no information about which one it became.
 *
 * `marginRatio` widens "tied" into "not clearly nearest": the runner-up must
 * be at least `marginRatio` times further away, so at the default `1` only an
 * exact tie abstains (the content pass's contract, unchanged), while the
 * successor stage passes `2` because it pairs entities whose DATA differs and
 * needs position to argue harder.
 */
function uniqueNearest(
  from: readonly Vec3[],
  to: readonly Vec3[],
  retiredFrom: ReadonlySet<number>,
  retiredTo: ReadonlySet<number>,
  marginRatio: number,
): Int32Array {
  const nearest = new Int32Array(from.length).fill(-1);
  for (let i = 0; i < from.length; i++) {
    if (retiredFrom.has(i)) continue;
    let bestIndex = -1;
    let best = Infinity;
    let second = Infinity;
    for (let j = 0; j < to.length; j++) {
      if (retiredTo.has(j)) continue;
      const distance = centreDistance(from[i], to[j]);
      if (distance < best) {
        second = best;
        best = distance;
        bestIndex = j;
      } else if (distance < second) {
        second = distance;
      }
    }
    // An exact tie always abstains (`best < second` strictly): an equidistant
    // runner-up means the nearest neighbour is not unique. A widened margin is
    // then met at its boundary inclusive — "at least twice as far" includes
    // exactly twice — so `marginRatio = 1` reproduces the strict tie rule and
    // nothing else.
    nearest[i] = bestIndex >= 0 && best < second && best * marginRatio <= second ? bestIndex : -1;
  }
  return nearest;
}

/**
 * Pair points from `base` and `head` by iterated mutual nearest neighbour
 * under `maxDistance`.
 *
 * A pair `(b, h)` is accepted only when `h` is `b`'s unique nearest unretired
 * head, `b` is `h`'s unique nearest unretired base, their distance is within
 * `maxDistance`, and `accept(b, h)` agrees. Accepted pairs are retired and the
 * search repeats until a round accepts nothing — retiring a confident pair can
 * make its neighbours unambiguous, which is why this iterates instead of
 * running once.
 *
 * `accept` is a *veto inside the pairing predicate*, not a filter over the
 * result, and the difference is load-bearing. Every round computes its mutual
 * nearest neighbours as if every previously accepted pair were gone, so a pair
 * discarded afterwards would leave later rounds resting on a pool that never
 * existed: a base whose true nearest head is the rejected one would be paired
 * with its runner-up instead. Vetoing here keeps both points in the pool for
 * every later round, so the rest of the group is paired against the real
 * candidate set.
 *
 * Termination does not depend on `accept`: a round that accepts nothing ends
 * the loop, and a round that accepts anything retires at least one point per
 * side, so there are at most `min(base.length, head.length)` rounds. A vetoed
 * pair is simply re-proposed and re-vetoed in the round that ends the loop —
 * it cannot spin, and it cannot pair either point with anyone else, because
 * being mutually nearest means neither has a closer partner and retirement
 * only ever removes candidates.
 *
 * Pairs are returned in ascending `base` index order so the result does not
 * depend on iteration order anywhere.
 *
 * `marginRatio` (default `1`, an exact tie abstains) is re-evaluated on the
 * reduced pool every round, intentionally: once a confident pair retires, a
 * runner-up that was inside the margin may no longer be there.
 */
export function mutualNearestPairs(
  base: readonly Vec3[],
  head: readonly Vec3[],
  maxDistance: number,
  accept: (baseIndex: number, headIndex: number) => boolean,
  marginRatio = 1,
): NearestPair[] {
  const pairs: NearestPair[] = [];
  const retiredBase = new Set<number>();
  const retiredHead = new Set<number>();

  while (retiredBase.size < base.length && retiredHead.size < head.length) {
    const nearestHead = uniqueNearest(base, head, retiredBase, retiredHead, marginRatio);
    const nearestBase = uniqueNearest(head, base, retiredHead, retiredBase, marginRatio);

    // Mutual pairs within one round are necessarily disjoint (each head has at
    // most one unique nearest base), so they can all be accepted together.
    const round: NearestPair[] = [];
    for (let b = 0; b < base.length; b++) {
      if (retiredBase.has(b)) continue;
      const h = nearestHead[b];
      if (h < 0 || nearestBase[h] !== b) continue;
      const distance = centreDistance(base[b], head[h]);
      if (!(distance <= maxDistance)) continue;
      if (!accept(b, h)) continue;
      round.push({ base: b, head: h, distance });
    }
    if (round.length === 0) break;

    for (const pair of round) {
      retiredBase.add(pair.base);
      retiredHead.add(pair.head);
      pairs.push(pair);
    }
  }

  pairs.sort((a, b) => a.base - b.base);
  return pairs;
}
