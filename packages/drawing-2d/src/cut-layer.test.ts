/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cut polygons carry the `IfcMaterial` of the layer they cut (#8449), and two
 * layers of the same colour stay two polygons instead of merging into one.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import { PolygonBuilder } from './polygon-builder.js';
import type { CutSegment, SectionConfig } from './types.js';

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

/** The 4 cut segments of the rectangle [x0,x1]×[0,1] on one entity. */
function rectSegments(x0: number, x1: number, materialId?: number): CutSegment[] {
  const corners: [number, number][] = [[x0, 0], [x1, 0], [x1, 1], [x0, 1]];
  return corners.map((a, i) => {
    const b = corners[(i + 1) % 4];
    return {
      p0: { x: a[0], y: a[1], z: 0 }, p1: { x: b[0], y: b[1], z: 0 },
      p0_2d: { x: a[0], y: a[1] }, p1_2d: { x: b[0], y: b[1] },
      entityId: 100, ifcType: 'IfcWall', modelIndex: 0, color: GREY,
      ...(materialId !== undefined ? { materialId } : {}),
    };
  });
}

/** Closed axis-aligned box, wound outward: one layer of a layered wall. */
function layerMesh(min: [number, number, number], max: [number, number, number], materialId: number): MeshData {
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
    expressId: 100, ifcType: 'IfcWall', modelIndex: 0, positions,
    normals: new Float32Array(positions.length), indices, color: GREY, materialId,
  };
}

describe('PolygonBuilder — material id on cut polygons', () => {
  it('keeps two layers of the same colour apart, each carrying its material', () => {
    const builder = new PolygonBuilder();
    const segments = [...rectSegments(0, 1, 11), ...rectSegments(1, 3, 12)];

    const polygons = builder.buildPolygons(segments);
    expect(polygons.map((p) => p.materialId).sort()).toEqual([11, 12]);
    for (const p of polygons) expect(p.entityId).toBe(100);

    // A multi-layer cut also gets its opaque base, as a two-colour one does.
    expect(builder.buildBasePolygons(segments)).not.toHaveLength(0);
  });

  it('stamps the material on a single-layer cut without a fill colour', () => {
    const [polygon, ...rest] = new PolygonBuilder().buildPolygons(rectSegments(0, 1, 11));
    expect(rest).toHaveLength(0);
    expect(polygon.materialId).toBe(11);
    expect(polygon.color).toBeUndefined();
  });

  it('leaves materialId off when the segments carry none', () => {
    const polygons = new PolygonBuilder().buildPolygons(rectSegments(0, 1));
    expect(polygons).toHaveLength(1);
    expect('materialId' in polygons[0]).toBe(false);
  });
});

describe('generate() — material id from MeshData to the cut', () => {
  it('carries each layer mesh\'s materialId onto its cut polygon', async () => {
    // A two-layer wall, both layers the same colour, cut in plan at y = 1.5.
    const meshes = [
      layerMesh([0, 0, 0], [0.1, 3, 4], 11),
      layerMesh([0.1, 0, 0], [0.3, 3, 4], 12),
    ];
    const config: SectionConfig = {
      plane: { axis: 'y', position: 1.5, flipped: false },
      projectionDepth: 3, includeHiddenLines: false, creaseAngle: 30, scale: 100,
    };
    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate(meshes, config, {
      useGPU: false, includeProjection: false, includeEdges: false, includeHiddenLines: false,
    });

    expect(drawing.cutPolygons.map((p) => p.materialId).sort()).toEqual([11, 12]);
    for (const p of drawing.cutPolygons) expect(p.entityId).toBe(100);
  });
});
