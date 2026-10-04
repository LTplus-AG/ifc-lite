/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Viewer runtime adapter for the canonical native Room footprint policy. */
import { SpacePlateHandle } from '@ifc-lite/wasm';
import { storeyFootprintFaceInStore } from '../../../../../packages/create/src/in-store/room-footprint-native.js';
import type { LayoutFace } from '../../../../../packages/create/src/in-store/room-layout-core.js';
import type { WallRect } from '@/lib/wall-rects-from-meshes';
export { exteriorPerimeter, perimeterWalls } from '../../../../../packages/create/src/in-store/room-footprint-native.js';

export function storeyFootprintFace(walls: readonly WallRect[], weld: number): LayoutFace | null {
  return storeyFootprintFaceInStore(SpacePlateHandle, walls, weld);
}
