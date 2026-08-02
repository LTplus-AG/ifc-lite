/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera framing box for a focused clash (#1466).
 *
 * Clicking a clash used to frame the UNION of the two whole clashing elements'
 * bounding boxes (via `frameSelection`). For a long member (a beam, a pipe, a
 * wall) that union is dominated by the element length, so the actual overlap
 * ended up tiny and off-centre — the "camera feels random / shows mostly the
 * beam" complaint in #1466.
 *
 * Instead we frame the CONTACT region: `Clash.bounds`, which is already the
 * tight overlap AABB (hard clash) or closest-segment box (clearance/touch) in
 * the same world frame the renderer draws the overlap-box overlay in (#1362,
 * #1402). We grow it by a little context so the penetration reads with its
 * surroundings rather than filling the whole frame, with a floor so a flush /
 * near-zero-thickness overlap still gets a human-scale neighbourhood instead of
 * a degenerate super-close zoom.
 */

import type { AABB } from '@ifc-lite/clash';

/** Context margin added on each side, as a fraction of the clash's largest dimension. */
export const CLASH_CONTEXT_PAD_FACTOR = 0.6;
/** Minimum context margin per side (metres) — the floor for tiny / flush overlaps. */
export const CLASH_CONTEXT_PAD_MIN_M = 0.5;

/**
 * Grow a clash's contact box into a camera framing box: centred on the overlap,
 * padded by `max(largestDim * FACTOR, MIN_M)` on every axis so the penetration
 * shows with a little context and a thin/flush overlap never collapses to a
 * point. `min`/`max` are normalised, so an inverted input box is tolerated.
 */
export function clashFramingBounds(bounds: AABB): AABB {
  const loX = Math.min(bounds.min[0], bounds.max[0]);
  const loY = Math.min(bounds.min[1], bounds.max[1]);
  const loZ = Math.min(bounds.min[2], bounds.max[2]);
  const hiX = Math.max(bounds.min[0], bounds.max[0]);
  const hiY = Math.max(bounds.min[1], bounds.max[1]);
  const hiZ = Math.max(bounds.min[2], bounds.max[2]);

  const maxDim = Math.max(hiX - loX, hiY - loY, hiZ - loZ);
  const pad = Math.max(maxDim * CLASH_CONTEXT_PAD_FACTOR, CLASH_CONTEXT_PAD_MIN_M);

  return {
    min: [loX - pad, loY - pad, loZ - pad],
    max: [hiX + pad, hiY + pad, hiZ + pad],
  };
}
