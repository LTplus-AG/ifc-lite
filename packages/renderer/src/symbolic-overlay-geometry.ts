/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { triangulateRings, type Pt } from './fill-triangulate.js';
import type { SymbolicFillInput } from './symbolic-overlay-pipelines.js';

export function parseBoxAlignment(s: string): { horizontal: number; vertical: number } {
  const norm = s.toLowerCase().trim();
  if (norm === '') return { horizontal: 0, vertical: -1 };
  const parts = norm.split('-');
  const verticalToken = parts.length >= 2 ? parts[0] : norm;
  const horizontalToken = parts.length >= 2 ? parts[1] : norm;
  const vertical = verticalToken.includes('top') ? 0
    : verticalToken.includes('middle') || verticalToken.includes('center') ? -0.5 : -1;
  const horizontal = horizontalToken.includes('right') ? -1
    : horizontalToken.includes('middle') || horizontalToken.includes('center') ? -0.5 : 0;
  return { horizontal, vertical };
}

export function triangulateFillTo(stream: number[], fill: SymbolicFillInput): void {
  const { points, holesOffsets, worldY, color } = fill;
  if (points.length < 6) return;
  const totalVertices = points.length / 2;
  const starts = [0, ...Array.from(holesOffsets), totalVertices];
  const rings: Pt[][] = [];
  for (let ringIndex = 0; ringIndex < starts.length - 1; ringIndex++) {
    const start = starts[ringIndex], end = starts[ringIndex + 1];
    if (end - start < 3) continue;
    const ring: Pt[] = [];
    for (let vertex = start; vertex < end; vertex++) ring.push({ x: points[vertex * 2], z: points[vertex * 2 + 1] });
    rings.push(ring);
  }
  if (rings.length === 0) return;
  const { points: vertices, triangles } = triangulateRings(rings);
  for (const triangle of triangles) for (const index of triangle) {
    const vertex = vertices[index];
    stream.push(vertex.x, worldY, vertex.z, color[0], color[1], color[2], color[3]);
  }
}
