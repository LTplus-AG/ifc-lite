/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WalkCharacter } from './walkCharacter.js';
import type { WalkCollisionWorld } from './walkCollisionWorld.js';

/** Horizontal reach of the prepared ring around the walker, in metres. */
const RING = 6;
/** Seconds of current velocity to look ahead, so a sprint is prepared before it arrives. */
const LEAD = 1;

/**
 * Prepare the entities around the walker under a time budget, leaning the box
 * toward where it is heading. Run once per frame after the physics ticks: the
 * ticks then only ever meet entities that are already indexed, and a large
 * mesh's one-off index build lands in a frame's slack instead of mid-step.
 */
export function prefetchAround(world: WalkCollisionWorld, c: WalkCharacter, budgetMs: number): number {
  const ax = c.velX * LEAD, az = c.velZ * LEAD;
  return world.prefetch(
    c.feetX - RING + Math.min(0, ax), c.feetY - 3, c.feetZ - RING + Math.min(0, az),
    c.feetX + RING + Math.max(0, ax), c.feetY + 4, c.feetZ + RING + Math.max(0, az),
    budgetMs,
  );
}
