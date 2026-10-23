/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Set view" (#7545): the camera looks straight at a cutting plane, from the
 * side the cut removed, at the part that stays, the way a 2D section is read.
 *
 * A cardinal plane has a preset for that (`presetViewForAxis`, the same mapping
 * the Drawing header's "Match 3D" applies). A face-picked plane has none, so
 * the pose is built: the eye sits on the removed side of the plane, looking
 * along the kept direction at the plane's live anchor, at the distance the
 * camera already has, with world up kept up wherever the plane is not
 * horizontal.
 */

import type { CameraViewpoint, SectionPlane } from '@/store/types';
import { customPlaneCenter } from '@/store/slices/section-plane-center';

type Vec3 = { x: number; y: number; z: number };

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * The viewpoint that looks perpendicular at a face-picked plane. The kept side
 * is where `(dot(p, n) - d) * side <= 0`: with `side = 1` (not flipped) that is
 * behind the plane, so the eye is on its +normal side; flipped, on its -normal side.
 */
export function customPlaneViewpoint(
  plane: Pick<SectionPlane, 'flipped'> & { custom: NonNullable<SectionPlane['custom']> },
  current: Pick<CameraViewpoint, 'position' | 'target' | 'fov' | 'projectionMode' | 'orthoSize'>,
): CameraViewpoint {
  const { normal } = plane.custom;
  const eyeSide = plane.flipped ? -1 : 1;
  const center = customPlaneCenter(plane.custom);
  const target: Vec3 = { x: center[0], y: center[1], z: center[2] };
  const distance = Math.max(
    1,
    Math.hypot(current.position.x - current.target.x, current.position.y - current.target.y, current.position.z - current.target.z),
  );
  const position: Vec3 = {
    x: target.x + eyeSide * normal[0] * distance,
    y: target.y + eyeSide * normal[1] * distance,
    z: target.z + eyeSide * normal[2] * distance,
  };
  // Up is world up projected into the view plane; a plane facing straight up or down has no such
  // direction, so the plane's own second axis stands in.
  const along = normal[1] * eyeSide;
  const horizontal = Math.abs(along) > 0.999;
  const up: Vec3 = horizontal
    ? { x: plane.custom.bitangent[0], y: plane.custom.bitangent[1], z: plane.custom.bitangent[2] }
    : { x: WORLD_UP.x - along * eyeSide * normal[0], y: WORLD_UP.y - along * eyeSide * normal[1], z: WORLD_UP.z - along * eyeSide * normal[2] };
  const len = Math.hypot(up.x, up.y, up.z) || 1;
  return {
    position, target,
    up: { x: up.x / len, y: up.y / len, z: up.z / len },
    fov: current.fov,
    projectionMode: current.projectionMode,
    ...(current.orthoSize === undefined ? {} : { orthoSize: current.orthoSize }),
  };
}
