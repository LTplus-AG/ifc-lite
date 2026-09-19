/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Camera, Renderer } from '@ifc-lite/renderer';

type FrameBoundsCamera = Pick<Camera, 'frameBounds'>;
type RenderInvalidator = Pick<Renderer, 'requestRender'>;
type FrameMin = Parameters<Camera['frameBounds']>[0];
type FrameMax = Parameters<Camera['frameBounds']>[1];

/** Frame selection bounds, dirty immediate frames, then publish pose-dependent UI. */
export function frameSelectionBounds(
  camera: FrameBoundsCamera,
  renderer: RenderInvalidator,
  min: FrameMin,
  max: FrameMax,
  durationMs: number,
  onFramed: () => void,
): Promise<void> {
  const frameReady = camera.frameBounds(min, max, durationMs);
  if (durationMs <= 0) renderer.requestRender();
  return frameReady.then(onFramed);
}
