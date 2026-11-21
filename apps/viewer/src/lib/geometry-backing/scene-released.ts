/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';

/** Whether the scene's CPU pieces were released (feature-detected: `SceneContents` does not publish it). */
export function sceneGeometryReleased(renderer: Pick<Renderer, 'getScene'>): boolean {
  const scene: object = renderer.getScene();
  return 'isGeometryDataReleased' in scene && typeof scene.isGeometryDataReleased === 'function'
    && scene.isGeometryDataReleased() === true;
}
