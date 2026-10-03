/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Viewer uses the canonical native-mesh Room footprint decoder (#6232 D5). */
export { roomFramePlanOffsets, roomFrameToModelWorld, footprintOBB, wallRectsFromMeshes, type WallRect } from '../../../../packages/create/src/in-store/room-wall-rects.js';
export { roomConvexHull as convexHull } from '../../../../packages/create/src/in-store/room-footprint-native.js';
