/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewpoint a "jump to peer" applies, from the camera a peer broadcasts
 * in presence: their position, target, fov and, from newer peers, `up`; our
 * own projection ("jump to roughly their view").
 *
 * `up` matters for a plan: a top or bottom view looks straight along the
 * vertical and keeps its rotation in a horizontal `up` alone (#9501), so
 * rebuilding it with world Y showed the plan turned. Older peers omit `up`,
 * and a non-finite one is ignored; both fall back to world Y.
 */

import type { CameraViewpoint } from '@/store/types';

type Vec3 = { x: number; y: number; z: number };

export interface PeerCamera { position: Vec3; target: Vec3; fov: number; up?: Vec3 }

const finite = (v: Vec3 | undefined): v is Vec3 => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export function peerViewpoint(camera: PeerCamera, projectionMode: CameraViewpoint['projectionMode']): CameraViewpoint {
  return {
    position: camera.position,
    target: camera.target,
    up: finite(camera.up) && Math.hypot(camera.up.x, camera.up.y, camera.up.z) > 0 ? camera.up : { x: 0, y: 1, z: 0 },
    fov: camera.fov,
    projectionMode,
  };
}
