/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SharedFaceCluster, Vec3 } from '@ifc-lite/clash/contact';

/**
 * Flatten contact clusters into a world-frame line-list (x,y,z per endpoint, two
 * per segment) for the focused-clash overlay. Prefer the shared-FACE polygon
 * outlines when any surface contact exists (flush/coincident members); otherwise
 * the intersection LINES (angled crossings); otherwise small crosses at POINT
 * contacts. This is the real contact interface, not an AABB box (#1402).
 */
export function contactLineList(clusters: readonly SharedFaceCluster[]): number[] {
  const surfaces = clusters.filter((c) => c.kind === 'surface' && c.boundary.length >= 3);
  const lines = clusters.filter((c) => c.kind === 'line' && c.boundary.length >= 2);
  const points = clusters.filter((c) => c.kind === 'point');
  const out: number[] = [];
  const seg = (p: Vec3, q: Vec3) => out.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  // Shared-face polygon outlines (the contact patches) and intersection lines
  // (penetration boundary) together describe the contact; render both so a thin
  // patch still reads. Points only matter when there is no surface or line.
  for (const c of surfaces) {
    const b = c.boundary;
    for (let i = 0; i < b.length; i += 1) seg(b[i], b[(i + 1) % b.length]);
  }
  for (const c of lines) seg(c.boundary[0], c.boundary[1]);
  if (surfaces.length === 0 && lines.length === 0) {
    const s = 0.05;
    for (const c of points) {
      const [x, y, z] = c.centroid;
      seg([x - s, y, z], [x + s, y, z]);
      seg([x, y - s, z], [x, y + s, z]);
      seg([x, y, z - s], [x, y, z + s]);
    }
  }
  return out;
}
