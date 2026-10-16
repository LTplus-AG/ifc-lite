/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The box and screen-axis arithmetic the framing fits share: the box type, its
 * centre, the eight corner offsets and the view axes a fit projects into.
 * Split from `camera-framing.ts` to keep that module under the size ceiling;
 * it re-exports the public pieces, so importers do not change.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';

/** An axis-aligned box. */
export interface FramingBounds {
  min: Vec3;
  max: Vec3;
}

/** Centre of a box. */
export function centerOf(min: Vec3, max: Vec3): Vec3 {
  return {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
}

/**
 * The viewport's width-to-height ratio, or 1 when it carries no usable one.
 *
 * `setAspect` is the only writer and already rejects a non-positive or
 * non-finite ratio, so the substitute is only for a hand-built state — but
 * both fits below key on it, and an `Infinity` would silently drop the
 * horizontal constraint from one while the other substituted.
 */
export function usableAspect(state: CameraInternalState): number {
  const aspect = state.camera.aspect;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/**
 * The screen axes a fit projects into: unit length and mutually perpendicular.
 *
 * A structural subset of what {@link viewBasis} returns, and the direction
 * convention is its one: `forward` points from the eye TOWARDS the target,
 * which is the negation of `lookAt`'s third row. Handing in the backward axis
 * type-checks and would frame the box from the wrong side.
 */
export interface ViewAxes {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/**
 * The eight corners of a box, as offsets from its own centre.
 *
 * Both fits below need exactly this, and the offset form is what makes the
 * corner arithmetic independent of where the box sits in the world. (The
 * package has other corner walks — `shadow-light-matrix.ts`,
 * `render-section-plane.ts` — but they take tuples and return world points.)
 */
export function cornerOffsets(bounds: FramingBounds): Vec3[] {
  const center = centerOf(bounds.min, bounds.max);
  const offsets: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        offsets.push({ x: x - center.x, y: y - center.y, z: z - center.z });
      }
    }
  }
  return offsets;
}

