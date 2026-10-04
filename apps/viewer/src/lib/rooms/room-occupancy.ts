/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared native space-mesh occupancy; no source footprint approximation (#6232 D5). */
export { isSimpleRing, occupancyTest, linkFaces, type RoomLink } from '../../../../../packages/create/src/in-store/room-candidates.js';
export { spaceMeshTriangles } from '../../../../../packages/create/src/in-store/room-space-meshes.js';
