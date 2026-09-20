/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Framing half of a manual clash-group focus: wait for the presentation
 * resets to reach the renderer, frame the selection, and pin the camera pose
 * the capture must reproduce. Split out of `group-focus.ts` (module budget). */

import { useViewerStore, type CameraViewpoint } from '@/store';

export interface FramedCamera {
  viewpoint: CameraViewpoint | null;
}

const LEVEL_DISPLAY_SETTLE_FRAME_LIMIT = 120;

/** Frame only after an Exploded -> Stacked translation has reached the renderer. */
export function scheduleClashFrame(
  waitForLevelDisplayReset: boolean,
  waitForPresentationReset: boolean,
  resolve: (framed: FramedCamera | null) => void,
): void {
  let framesRemaining = LEVEL_DISPLAY_SETTLE_FRAME_LIMIT;
  let settledFrameSeen = !waitForLevelDisplayReset;
  const frameWhenReady = (): void => {
    if (waitForPresentationReset) {
      // Type filtering rebuilds the geometry passed to ViewportContainer.
      // Let that React commit paint before asking the renderer for bounds.
      waitForPresentationReset = false;
      requestAnimationFrame(frameWhenReady);
      return;
    }
    if (waitForLevelDisplayReset) {
      const state = useViewerStore.getState();
      const offsetsPending = state.appliedStoreyOffsets.size > 0
        || state.pendingMeshTranslations !== null;
      if (offsetsPending) {
        settledFrameSeen = false;
      } else if (!settledFrameSeen) {
        // The translation queue was drained in a React effect. Give the renderer
        // one paint frame before deriving bounds from the now-stacked geometry.
        settledFrameSeen = true;
        requestAnimationFrame(frameWhenReady);
        return;
      } else {
        waitForLevelDisplayReset = false;
      }
      if (waitForLevelDisplayReset) {
        framesRemaining -= 1;
        if (framesRemaining <= 0) {
          console.error('[clash] Timed out while restoring stacked geometry before framing.');
          resolve(null);
          return;
        }
        requestAnimationFrame(frameWhenReady);
        return;
      }
    }

    const frameSelection = useViewerStore.getState().cameraCallbacks.frameSelection;
    if (!frameSelection) {
      resolve(null);
      return;
    }
    try {
      // The callback remains void-compatible for existing synchronous callers,
      // while Viewport returns false specifically when it has no bounds.
      const frameResult: unknown = frameSelection(0);
      Promise.resolve(frameResult).then((didFrame) => {
        if (didFrame === false) {
          resolve(null);
          return;
        }
        resolve({ viewpoint: currentCameraViewpoint() });
      }, (error) => {
        console.error('[clash] Could not finish framing the manual clash group:', error);
        resolve(null);
      });
    } catch (error) {
      console.error('[clash] Could not frame the manual clash group:', error);
      resolve(null);
    }
  };
  requestAnimationFrame(frameWhenReady);
}

function currentCameraViewpoint(): CameraViewpoint | null {
  try {
    return useViewerStore.getState().cameraCallbacks.getViewpoint?.() ?? null;
  } catch (error) {
    console.error('[clash] Could not read the framed camera viewpoint:', error);
    return null;
  }
}

/** True while no competing navigation has changed the camera selected for capture. */
export function focusedCameraViewpointIsCurrent(framed: FramedCamera | null): boolean {
  if (!framed) return false;
  const expected = framed.viewpoint;
  const canReadCurrent = useViewerStore.getState().cameraCallbacks.getViewpoint !== undefined;
  if (!expected && !canReadCurrent) return true;
  const current = currentCameraViewpoint();
  if (!expected || !current) return false;
  return current.position.x === expected.position.x
    && current.position.y === expected.position.y
    && current.position.z === expected.position.z
    && current.target.x === expected.target.x
    && current.target.y === expected.target.y
    && current.target.z === expected.target.z
    && current.up.x === expected.up.x
    && current.up.y === expected.up.y
    && current.up.z === expected.up.z
    && current.fov === expected.fov
    && current.projectionMode === expected.projectionMode
    && current.orthoSize === expected.orthoSize;
}
