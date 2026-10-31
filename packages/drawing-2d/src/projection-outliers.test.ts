/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Artifact-line filtering against the cut area ∪ the meshes' projected
 * footprint: an elevation whose plane cuts almost nothing keeps its real
 * facade lines, while a line longer than the whole model is still dropped.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import { dropOutlierProjectionLines, projectedMeshBounds } from './projection-outliers.js';
import type { DrawingLine, SectionConfig, SectionPlaneConfig } from './types.js';

function cornersMesh(min: [number, number, number], max: [number, number, number], origin?: [number, number, number]): MeshData {
  const o = origin ?? [0, 0, 0];
  const positions = new Float32Array([
    min[0] - o[0], min[1] - o[1], min[2] - o[2],
    max[0] - o[0], max[1] - o[1], max[2] - o[2],
  ]);
  return {
    expressId: 1, ifcType: 'IfcWall', modelIndex: 0, positions,
    normals: new Float32Array(6), indices: new Uint32Array(0), color: [1, 1, 1, 1],
    ...(origin ? { origin } : {}),
  };
}

function line(length: number): DrawingLine {
  return {
    line: { start: { x: 0, y: 0 }, end: { x: length, y: 0 } },
    category: 'projection', visibility: 'visible', entityId: 1, ifcType: 'IfcWall', modelIndex: 0, depth: 1,
  } as DrawingLine;
}

const front: SectionPlaneConfig = { axis: 'z', position: 9.9, flipped: false };
const empty = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
const tiny = { min: { x: 0, y: 0 }, max: { x: 0.1, y: 0.1 } };

describe('projectedMeshBounds', () => {
  it('projects world positions (origin + local) onto the cardinal plane axes', () => {
    const mesh = cornersMesh([100, 0, 0], [140, 12, 10], [100, 0, 0]);
    expect(projectedMeshBounds([mesh], front)).toEqual({ min: { x: 100, y: 0 }, max: { x: 140, y: 12 } });
  });

  it('mirrors U on a flipped plane', () => {
    const mesh = cornersMesh([0, 0, 0], [40, 12, 10]);
    expect(projectedMeshBounds([mesh], { ...front, flipped: true })).toEqual({ min: { x: -40, y: 0 }, max: { x: -0, y: 12 } });
  });
});

describe('dropOutlierProjectionLines', () => {
  const building = [cornersMesh([0, 0, 0], [40, 12, 10])];

  it('keeps facade lines when the plane cuts only a sliver', () => {
    const kept = dropOutlierProjectionLines([line(40), line(12)], tiny, building, front);
    expect(kept).toHaveLength(2);
  });

  it('still drops a line far longer than the whole model', () => {
    const kept = dropOutlierProjectionLines([line(40), line(500)], tiny, building, front);
    expect(kept.map((l) => l.line.end.x)).toEqual([40]);
  });

  it('keeps everything when neither extent is known', () => {
    expect(dropOutlierProjectionLines([line(500)], empty, [], front)).toHaveLength(1);
  });
});

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
  it('keeps the facade lines of an elevation placed just inside the model bounds', async () => {
    // A 40 × 12 m facade (z in [0, 9.5]) and a 0.1 × 1 m post that reaches
    // past it. The elevation plane at z = 9.8 cuts the post only, so the cut
    // area's diagonal is about 1 m; the facade edges (40 m, 12 m) used to be
    // dropped as outliers against it.
    const facade = boxMesh(1, [0, 0, 0], [40, 12, 9.5]);
    const post = boxMesh(2, [5, 3, 9.6], [5.1, 4, 10]);
    const config: SectionConfig = {
      plane: { axis: 'z', position: 9.8, flipped: false },
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

    // The post is cut, so the cut-area reference is in play.
    expect(drawing.lines.some((l) => l.category === 'cut' && l.entityId === 2)).toBe(true);
    const facadeLengths = drawing.lines
      .filter((l) => l.category === 'projection' && l.entityId === 1)
      .map((l) => Math.round(Math.hypot(l.line.end.x - l.line.start.x, l.line.end.y - l.line.start.y)))
      .sort((a, b) => a - b);
    expect(facadeLengths).toEqual([12, 12, 40, 40]);
  });
});
