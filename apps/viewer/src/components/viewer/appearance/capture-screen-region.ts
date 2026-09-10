/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
type Point = { x: number; y: number };
/** Through-surface marquee: choose complete triangles by their projected
 * centroid. This intentionally does not invent geometry at the rectangle edge. */
export function capturedScreenRegion(mesh: MeshData, start: Point, end: Point,
  project: (point: { x: number; y: number; z: number }) => Point | null): number[] {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw new Error('Choose a finite rectangle.');
  if (mesh.indices.length / 3 > 200_000) throw new Error('Choose a source surface with at most 200000 triangles.');
  const result: number[] = [];
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle++) {
    let x = 0, y = 0, z = 0;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = mesh.indices[triangle * 3 + corner];
      x += mesh.positions[vertex * 3] / 3; y += mesh.positions[vertex * 3 + 1] / 3; z += mesh.positions[vertex * 3 + 2] / 3;
    }
    const screen = project({ x, y, z });
    if (screen && screen.x >= Math.min(start.x, end.x) && screen.x <= Math.max(start.x, end.x)
      && screen.y >= Math.min(start.y, end.y) && screen.y <= Math.max(start.y, end.y)) result.push(triangle);
  }
  return result;
}
