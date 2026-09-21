/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Camera } from './camera.js';
import type { RelativeToEyeSnapshot } from './relative-to-eye.js';

interface RteCamera {
  getRelativeToEyeFrame?: () => {
    snapshot(): RelativeToEyeSnapshot;
    getRenderEpoch(): number;
  };
}

/** Test doubles predating #5049 have no RTE frame; production Camera does. */
export function capturePointRteSnapshot(camera: Camera): RelativeToEyeSnapshot | undefined {
  const rteCamera: RteCamera = camera;
  return rteCamera.getRelativeToEyeFrame?.().snapshot();
}

/** Reject delayed readback after navigation changed the camera-relative frame. */
export function isPointRteSnapshotCurrent(camera: Camera, snapshot: RelativeToEyeSnapshot): boolean {
  const rteCamera: RteCamera = camera;
  const frame = rteCamera.getRelativeToEyeFrame?.();
  return !frame || frame.getRenderEpoch() === snapshot.renderEpoch;
}
