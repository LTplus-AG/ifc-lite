/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';

/** Whether the scene's CPU pieces were released (feature-detected: `SceneContents` does not publish it). */
export function sceneGeometryReleased(renderer: Pick<Renderer, 'getScene'>): boolean {
  // A host stub without a scene (or none yet) has released nothing.
  if (typeof renderer.getScene !== 'function') return false;
  const scene: object | null | undefined = renderer.getScene();
  if (!scene) return false;
  return 'isGeometryDataReleased' in scene && typeof scene.isGeometryDataReleased === 'function'
    && scene.isGeometryDataReleased() === true;
}
