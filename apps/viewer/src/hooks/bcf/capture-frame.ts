/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';
import type { ViewerCameraState } from '@ifc-lite/bcf';
import { captureViewportFrame } from '@/lib/viewport-capture';

/** The BCF image and camera describe the same owned frame, including resize (#6709). */
export function captureBcfFrame(
  renderer: Renderer | null, canvas: HTMLCanvasElement | null,
  readCamera: () => ViewerCameraState | null,
): Promise<{ snapshot: string; camera: ViewerCameraState | null } | null> {
  if (!renderer || !canvas) {
    console.warn('[useBCF] No viewport available for snapshot capture');
    return Promise.resolve(null);
  }
  let camera: ViewerCameraState | null = null;
  return captureViewportFrame(renderer, {
    canvas,
    afterRender: () => {
      const state = readCamera();
      camera = state ? { ...state, position: { ...state.position }, target: { ...state.target }, up: { ...state.up } } : null;
    },
    read: ownedCanvas => ({ snapshot: ownedCanvas.toDataURL('image/png'), camera }),
  });
}
