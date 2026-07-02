/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a flat line-list (`[x,y,z, …]`, 12 edges = 24 vertices) for the 12 edges
 * of a world-space AABB. Used to draw the clash-overlap wireframe box (#1277).
 */
export function aabbEdgeLineList(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  // 8 corners
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // z0 face
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], // z1 face
  ];
  // 12 edges as corner-index pairs
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0], // z0 ring
    [4, 5], [5, 6], [6, 7], [7, 4], // z1 ring
    [0, 4], [1, 5], [2, 6], [3, 7], // verticals
  ];
  const out = new Float32Array(edges.length * 2 * 3);
  let o = 0;
  for (const [a, b] of edges) {
    out[o++] = c[a][0]; out[o++] = c[a][1]; out[o++] = c[a][2];
    out[o++] = c[b][0]; out[o++] = c[b][1]; out[o++] = c[b][2];
  }
  return out;
}
