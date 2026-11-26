/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { generateFloorPlan } from './drawing-generator.js';
import type { Drawing2D } from './types.js';

type V3 = [number, number, number];

function box(expressId: number, ifcType: string, min: V3, max: V3, geometryClass?: number): MeshData {
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
    expressId,
    ifcType,
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [1, 1, 1, 1],
    ...(geometryClass === undefined ? {} : { geometryClass }),
  };
}

const drawnIds = (drawing: Drawing2D): Set<number> =>
  new Set([...drawing.cutPolygons.map((p) => p.entityId), ...drawing.lines.map((l) => l.entityId)]);

const options = { useGPU: false, includeHiddenLines: false } as const;

describe('type-library geometry stays out of headless plans (#10929)', () => {
  const wall = box(1, 'IfcWall', [0, 0, 0], [4, 3, 0.3]);
  const instancedType = box(2, 'IfcWallType', [-0.5, 0, -0.5], [0.5, 3, 0.5], 2);
  const orphanType = box(3, 'IfcSlabType', [5, 0, 5], [6, 3, 6], 1);

  it('cuts placed elements but not instanced or orphan type representation maps', async () => {
    const ids = drawnIds(await generateFloorPlan([wall, instancedType, orphanType], 1.2, options));
    expect(ids.has(1)).toBe(true);
    expect(ids.has(2)).toBe(false);
    expect(ids.has(3)).toBe(false);
  });

  it('still draws the orphan type geometry of a file that has no placed elements', async () => {
    const ids = drawnIds(await generateFloorPlan([orphanType], 1.2, options));
    expect(ids.has(3)).toBe(true);
  });
});
