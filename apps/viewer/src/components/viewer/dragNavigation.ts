/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera move of one navigating drag, for the mouse controls and a finger
 * or Pencil drag in the touch controls alike (#9042): Pan pans, Walk looks
 * around the eye (the walker owns where it stands), anything else orbits.
 */

import type { Camera } from '@ifc-lite/renderer';
import { flyLook } from './flyNavigation.js';

export type DragNavigation = 'orbit' | 'pan' | 'look';

/** `panning` is the press's resolved gesture; a one-finger drag pans only in the Pan tool. */
export function dragNavigationFor(tool: string, panning = tool === 'pan'): DragNavigation {
  if (panning) return 'pan';
  return tool === 'walk' ? 'look' : 'orbit';
}

export function applyDragNavigation(camera: Camera, kind: DragNavigation, dx: number, dy: number): void {
  if (kind === 'pan') {
    camera.pan(dx, dy, false);
  } else if (kind === 'look') {
    const look = flyLook({ position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp() }, dx, dy);
    if (look) {
      camera.setTarget(look.target.x, look.target.y, look.target.z);
      // A look off a top preset (#9501) leaves the plan's horizontal up behind.
      if (look.up) camera.setUp(look.up.x, look.up.y, look.up.z);
    }
  } else {
    camera.orbit(dx, dy, false);
  }
}
