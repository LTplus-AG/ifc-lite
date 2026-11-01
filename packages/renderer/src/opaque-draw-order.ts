/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Front-to-back order for the opaque colour batches.
 *
 * Opaque draws write depth, so the order they are submitted in does not change
 * the picture except where two surfaces land on the same depth value: the
 * per-entity depth nudge (`depth-nudge.wgsl.ts`) separates coplanar faces of
 * different entities, so only exact hash collisions are left to draw order.
 * The order does decide how much is shaded: a fragment behind depth already
 * written is rejected before shading once the fragment stage cannot discard
 * (`opaque-draw-variants.ts`), so drawing the nearest batches first lets the
 * depth buffer reject most of the overdraw behind them.
 *
 * The key is the squared distance from the eye to the batch's world AABB (zero
 * when the eye is inside it), so a model-sized batch around the camera draws
 * first rather than at its far-away centre. Batches without bounds keep their
 * relative order after every bounded one. Ties keep submission order (the sort
 * is stable), so a static camera always yields the same sequence.
 */

interface Vec3Like { x: number; y: number; z: number }

interface BoundedBatch {
  bounds?: { min: ArrayLike<number>; max: ArrayLike<number> };
}

/** Squared distance from `eye` to the box `[min, max]`; 0 inside it. */
export function eyeToBoxDistanceSq(eye: Vec3Like, min: ArrayLike<number>, max: ArrayLike<number>): number {
  const dx = Math.max(min[0]! - eye.x, 0, eye.x - max[0]!);
  const dy = Math.max(min[1]! - eye.y, 0, eye.y - max[1]!);
  const dz = Math.max(min[2]! - eye.z, 0, eye.z - max[2]!);
  return dx * dx + dy * dy + dz * dz;
}

/** Sort `batches` in place, nearest AABB first; returns the same array. */
export function sortOpaqueFrontToBack<T extends BoundedBatch>(batches: T[], eye: Vec3Like): T[] {
  if (batches.length < 2) return batches;
  const keyed = batches.map((batch, index) => ({
    batch,
    index,
    key: batch.bounds ? eyeToBoxDistanceSq(eye, batch.bounds.min, batch.bounds.max) : Number.POSITIVE_INFINITY,
  }));
  keyed.sort((a, b) => (a.key - b.key) || (a.index - b.index));
  for (let i = 0; i < keyed.length; i++) batches[i] = keyed[i]!.batch;
  return batches;
}
