/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertFinitePoint3, vecCross, vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';

/** Native beam/member profile frame, also consumed by their reviewed ghosts. */
export function linearProfileFrame(Start: Point3D, End: Point3D) {
  assertFinitePoint3({ Start, End }, 'linearProfileFrame');
  const delta: Point3D = [End[0] - Start[0], End[1] - Start[1], End[2] - Start[2]];
  const length = Math.hypot(...delta);
  if (!(length > 0)) throw new Error('linearProfileFrame: Start and End must be distinct');
  const along = vecNorm(delta);
  const up: Point3D = Math.abs(along[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
  const u = vecNorm(vecCross(up, along));
  return { origin: Start, u, v: vecCross(along, u), along, length };
}
