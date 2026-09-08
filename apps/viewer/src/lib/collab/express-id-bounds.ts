/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The expressId high-water mark a reconstructed room model is gated on.
 *
 * Lives here rather than in `collabSlice` for two reasons. It is pure, so it is
 * testable without driving an async reconstruct nothing can start; and #2706
 * moves the reconstruct itself into `lib/collab/room-model-apply.ts`, so the
 * rule is already where that refactor will want it instead of having to be
 * carried across in the same change.
 */

/**
 * Highest expressId in a reconstructed id map, or 0 when there is none.
 *
 * One definition for both reconstruct branches: the first build and every
 * re-derive have to agree on what the bound means, and computing it twice by
 * hand is how they came to disagree (#2719).
 */
export function highestExpressId(idToPath: Map<number, string> | undefined): number {
  let max = 0;
  if (idToPath) {
    for (const id of idToPath.keys()) if (id > max) max = id;
  }
  return max;
}

/**
 * The new `maxExpressId` bound for a re-derived room model, or `null` when it
 * must not move.
 *
 * RAISED, NEVER LOWERED. A peer deleting an entity shrinks the id space, but
 * ids already handed out elsewhere (selection, annotations, a pending mesh)
 * have to keep resolving through `globalId.ts`'s
 * `localExpressId <= model.maxExpressId` gate, so the bound is a high-water
 * mark rather than a current count. Lowering it would turn a delete into a
 * silent unresolvable-selection bug, which is the same defect as the freeze,
 * just triggered from the other direction.
 */
export function raisedMaxExpressId(
  current: number,
  idToPath: Map<number, string> | undefined,
): number | null {
  const seen = highestExpressId(idToPath);
  return seen > current ? seen : null;
}
