/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerCameraState } from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';

const cameraRestoreSequence = new WeakMap<ReturnType<Renderer['getCamera']>, number>();

/** Apply extracted BCF camera state without touching selection, visibility, or section plane. */
export function applyCameraState(renderer: Renderer, camera: ViewerCameraState, animate: boolean): void {
  const rendererCamera = renderer.getCamera();
  const sequence = (cameraRestoreSequence.get(rendererCamera) ?? 0) + 1;
  cameraRestoreSequence.set(rendererCamera, sequence);
  rendererCamera.setProjectionMode(camera.isOrthographic ? 'orthographic' : 'perspective');
  if (animate) {
    // The renderer tweens the pose and up vector together. FOV and ortho size
    // have no combined tween API, so apply them when this transition settles.
    void rendererCamera.animateToWithUp(camera.position, camera.target, camera.up, 300).then(() => {
      if (cameraRestoreSequence.get(rendererCamera) !== sequence) return;
      if (camera.isOrthographic) {
        if (camera.orthoScale !== undefined) rendererCamera.setOrthoSize(camera.orthoScale);
      } else {
        rendererCamera.setFOV(camera.fov);
      }
    });
  } else {
    rendererCamera.setPosition(camera.position.x, camera.position.y, camera.position.z);
    rendererCamera.setTarget(camera.target.x, camera.target.y, camera.target.z);
    rendererCamera.setUp(camera.up.x, camera.up.y, camera.up.z);
    if (camera.isOrthographic) {
      if (camera.orthoScale !== undefined) rendererCamera.setOrthoSize(camera.orthoScale);
    } else {
      rendererCamera.setFOV(camera.fov);
    }
  }
}
