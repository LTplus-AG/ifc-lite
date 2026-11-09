/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small cut footprint must not discard longer projected facade edges.
 * Projection follows the configured depth and visibility, with no length heuristic.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import type { SectionConfig } from './types.js';

/** Closed axis-aligned box, wound outward, positions in world coordinates. */
function boxMesh(expressId: number, min: [number, number, number], max: [number, number, number]): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return {
    expressId, ifcType: 'IfcWall', modelIndex: 0, positions,
    normals: new Float32Array(positions.length), indices, color: [1, 1, 1, 1],
  };
}

describe('generate() on a plane that cuts only a sliver (issue #8448)', () => {
  it.each([false, true])('keeps facade lines on a sliver cut (flipped: %s)', async (flipped) => {
    // A 40 × 12 m facade (z in [0, 9.5]) and a 0.1 × 1 m post that reaches
    // past it. The elevation plane at z = 9.8 cuts the post only, so the cut
    // area's diagonal is about 1 m; the facade edges (40 m, 12 m) used to be
    // dropped as outliers against it.
    const facade = flipped
      ? boxMesh(1, [0, 0, 10.1], [40, 12, 19.6])
      : boxMesh(1, [0, 0, 0], [40, 12, 9.5]);
    const post = boxMesh(2, [5, 3, 9.6], [5.1, 4, 10]);
    const config: SectionConfig = {
      plane: { axis: 'z', position: 9.8, flipped },
      projectionDepth: 20,
      projectionBelowDepth: 20,
      projectionAboveDepth: 0.001,
      includeHiddenLines: false,
      creaseAngle: 30,
      scale: 100,
    };

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate([facade, post], config, {
      useGPU: false, mergeLines: false, includeProjection: true, includeEdges: true, includeHiddenLines: false,
    });

    // Verify the small cut and the much longer projected facade coexist.
    expect(drawing.lines.some((l) => l.category === 'cut' && l.entityId === 2)).toBe(true);
    const facadeLengths = drawing.lines
      .filter((l) => l.category === 'projection' && l.entityId === 1)
      .map((l) => Math.round(Math.hypot(l.line.end.x - l.line.start.x, l.line.end.y - l.line.start.y)))
      .sort((a, b) => a - b);
    expect(facadeLengths).toEqual([12, 12, 40, 40]);
  });
});
