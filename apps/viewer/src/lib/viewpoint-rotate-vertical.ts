/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pose of the viewer's rotate-left/right step: the camera turned about the
 * vertical through its target by `angle`, in `CameraControls`' spherical-orbit
 * convention.
 *
 * `up` turns with the position. Straight down from a top preset (or up from a
 * bottom one, or a plan viewpoint) the position has no horizontal offset to
 * turn, so the screen orientation lives in a horizontal `up` alone (#9501);
 * turning only the position left those views exactly where they were.
 */

type Vec3 = { x: number; y: number; z: number };

const turn = (v: Vec3, cosine: number, sine: number): Vec3 => ({
  x: v.x * cosine + v.z * sine,
  y: v.y,
  z: -v.x * sine + v.z * cosine,
});

export function rotateAboutVertical(
  pose: { position: Vec3; target: Vec3; up: Vec3 },
  angle: number,
): { position: Vec3; target: Vec3; up: Vec3 } {
  const { position, target } = pose;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const offset = turn({ x: position.x - target.x, y: 0, z: position.z - target.z }, cosine, sine);
  return {
    position: { x: target.x + offset.x, y: position.y, z: target.z + offset.z },
    target: { ...target },
    up: turn(pose.up, cosine, sine),
  };
}
