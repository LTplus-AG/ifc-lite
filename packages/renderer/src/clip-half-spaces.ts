/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState } from './pick-types.js';
import type { Vec3 } from './types.js';

/** Keeps points with `dot(p, n) <= limit`; `n` points into the cut-away side. */
export interface ClipHalfSpace {
  n: readonly [number, number, number];
  limit: number;
  /** A filled cut face is drawn on this plane. A crop box never fills its faces. */
  capped: boolean;
}

/** The half-spaces of a clip state, in the renderer's discard convention. */
export function clipHalfSpaces(clip: PickClipState): ClipHalfSpace[] {
  const planes: ClipHalfSpace[] = [];
  const capped = clip.capsVisible === true;
  const section = clip.sectionPlane;
  if (section) {
    const side = section.flipped ? -1 : 1;
    planes.push({ n: [section.normal[0] * side, section.normal[1] * side, section.normal[2] * side],
      limit: section.distance * side, capped });
  }
  for (const extra of clip.extraPlanes ?? []) {
    const side = extra.flipped ? -1 : 1;
    planes.push({ n: [extra.normal[0] * side, extra.normal[1] * side, extra.normal[2] * side], limit: extra.distance * side, capped });
  }
  const box = clip.clipBox;
  if (box?.enabled) for (let axis = 0; axis < 3; axis++) {
    const positive: [number, number, number] = [0, 0, 0];
    const negative: [number, number, number] = [0, 0, 0];
    positive[axis] = 1;
    negative[axis] = -1;
    planes.push({ n: positive, limit: box.max[axis], capped: false }, { n: negative, limit: -box.min[axis], capped: false });
  }
  return planes;
}

/**
 * Liang-Barsky in parameter space: the part of segment a-b every half-space
 * keeps, or null. Catches a narrow interior even when both endpoints are clipped.
 * `tol` keeps a segment lying on a plane, whose f32 noise can land either side.
 */
export function clipSegmentInterval(
  a: Vec3, b: Vec3, planes: readonly ClipHalfSpace[], tol = 0,
): [number, number] | null {
  let low = 0, high = 1;
  for (const { n, limit } of planes) {
    const start = a.x * n[0] + a.y * n[1] + a.z * n[2] - limit;
    const end = b.x * n[0] + b.y * n[1] + b.z * n[2] - limit;
    const startOut = start > tol, endOut = end > tol;
    if (startOut && endOut) return null;
    if (!startOut && !endOut) continue;
    const root = Math.max(0, Math.min(1, start / (start - end)));
    if (startOut) low = Math.max(low, root);
    else high = Math.min(high, root);
    if (low > high) return null;
  }
  return [low, high];
}
