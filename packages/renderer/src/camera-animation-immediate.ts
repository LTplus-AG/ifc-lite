/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { usableOrthoSize } from './camera-guards.js';

/** Apply a capture-specific camera pose without entering the shared tween state. */
export function applyImmediateCameraPose(
  state: CameraInternalState,
  position: Vec3,
  target: Vec3,
  up: Vec3 | null,
  orthoSize: number | undefined,
  updateMatrices: () => void,
): void {
  state.camera.position = { ...position };
  state.camera.target = { ...target };
  if (up) state.camera.up = { ...up };
  const nextOrthoSize = orthoSize === undefined ? null : usableOrthoSize(orthoSize);
  if (nextOrthoSize !== null) state.orthoSize = nextOrthoSize;
  updateMatrices();
}
