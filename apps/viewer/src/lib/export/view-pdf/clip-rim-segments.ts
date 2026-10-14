/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keep the part of each rim segment on the kept side of a half-space (#7545).
 *
 * With several cutting planes the sheet is cut plane after plane. The rim a plane
 * leaves on the model (the heavy cut line) is only a cut line where the OTHER
 * planes also keep it: a rim edge that lies in the region plane B removes is not
 * on the drawn model any more, and printing it would draw a line in mid-air.
 * So the rim of every plane is clipped by the planes applied after it.
 */

import type { Vec3, WorldSegment } from '@ifc-lite/drawing-2d';

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Segments (or their kept pieces) with `dot(p, normal) <= offset`. A segment lying on the plane is kept. */
export function clipSegmentsToHalfSpace(
  segments: readonly WorldSegment[],
  normal: Vec3,
  offset: number,
): WorldSegment[] {
  const out: WorldSegment[] = [];
  for (const segment of segments) {
    const a = dot(segment.start, normal) - offset;
    const b = dot(segment.end, normal) - offset;
    if (a <= 0 && b <= 0) { out.push(segment); continue; }
    if (a > 0 && b > 0) continue;
    const t = a / (a - b);
    const cut: Vec3 = {
      x: segment.start.x + (segment.end.x - segment.start.x) * t,
      y: segment.start.y + (segment.end.y - segment.start.y) * t,
      z: segment.start.z + (segment.end.z - segment.start.z) * t,
    };
    out.push(a <= 0 ? { ...segment, end: cut } : { ...segment, start: cut });
  }
  return out;
}
