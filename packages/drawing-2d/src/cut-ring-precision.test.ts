/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cut-ring collinear cleanup far from the model origin.
 *
 * Elements authored without a per-element origin store WORLD coordinates in
 * their Float32Array positions. At ~100 m from the origin float32 rounds each
 * coordinate by up to ~4 µm, so a tessellation split point on a sloped face
 * lands a few µm off the chord between its neighbours. The collinear test
 * must absorb that noise without ever eating real corners, short real edges
 * or arc tessellation.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import type { Point2D, SectionConfig } from './types.js';

type XZ = [number, number];

/**
 * Prism with a horizontal bottom footprint at y = 0 and a top footprint at
 * y = `height` (same vertex count, may differ to make side faces slope). Only
 * the side faces are emitted, each quad as two triangles: a horizontal cut
 * crosses every quad's diagonal, so each side face reaches the cutter as two
 * collinear segments. The element is rotated about the vertical axis by
 * `angleDeg`, moved by `offset`, and stored as world coordinates in a
 * Float32Array with no origin, exactly as an origin-less IFC element arrives.
 */
function prismMesh(
  expressId: number,
  bottom: XZ[],
  top: XZ[],
  height: number,
  angleDeg: number,
  offset: XZ,
): MeshData {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const place = ([x, z]: XZ, y: number): number[] => [
    offset[0] + c * x - s * z,
    y,
    offset[1] + s * x + c * z,
  ];
  const n = bottom.length;
  const coords: number[] = [];
  for (const p of bottom) coords.push(...place(p, 0));
  for (const p of top) coords.push(...place(p, height));
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  const positions = new Float32Array(coords);
  return {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    color: [1, 1, 1, 1],
  };
}

const PLAN_CUT: SectionConfig = {
  plane: { axis: 'y', position: 1.3, flipped: false },
  projectionDepth: 3,
  projectionBelowDepth: 3,
  projectionAboveDepth: 3,
  includeHiddenLines: true,
  creaseAngle: 30,
  scale: 100,
};

async function cutRing(mesh: MeshData): Promise<Point2D[]> {
  const generator = new Drawing2DGenerator();
  await generator.initialize();
  const drawing = await generator.generate([mesh], PLAN_CUT, {
    useGPU: false,
    mergeLines: false,
    includeProjection: false,
    includeEdges: false,
    includeHiddenLines: false,
  });
  const rings = drawing.cutPolygons.filter((p) => p.entityId === mesh.expressId);
  expect(rings).toHaveLength(1);
  return rings[0].polygon.outer;
}

const ANGLES = [0, 17, 33, 45, 61, 78, 123];
const FAR: XZ = [100, 100];

describe('cut rings far from the origin (float32 world coordinates)', () => {
  // A battered wall: 6 m long, 0.6 m thick at the base, 0.2 m at the top, so
  // the inner face slopes. Cut at 1.3 m, every face carries a split point.
  const battered = (angle: number, offset: XZ) =>
    prismMesh(
      1,
      [[0, 0], [6, 0], [6, 0.6], [0, 0.6]],
      [[0, 0], [6, 0], [6, 0.2], [0, 0.2]],
      3,
      angle,
      offset,
    );

  it.each(ANGLES)('drops the split point on a sloped face at 100 m (rotated %d°)', async (angle) => {
    const ring = await cutRing(battered(angle, FAR));
    expect(ring).toHaveLength(4);
  });

  it.each(ANGLES)('still drops it near the origin (rotated %d°)', async (angle) => {
    const ring = await cutRing(battered(angle, [0, 0]));
    expect(ring).toHaveLength(4);
  });

  it.each(ANGLES)('keeps both vertices of a 1 mm chamfer at 100 m (rotated %d°)', async (angle) => {
    // 6 m x 0.2 m wall with one corner chamfered 1 mm x 1 mm: five real corners.
    const outline: XZ[] = [[0, 0], [5.999, 0], [6, 0.001], [6, 0.2], [0, 0.2]];
    const ring = await cutRing(prismMesh(2, outline, outline, 3, angle, FAR));
    expect(ring).toHaveLength(5);
    const edges = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      return Math.hypot(q.x - p.x, q.y - p.y);
    });
    expect(Math.min(...edges)).toBeCloseTo(Math.SQRT2 * 0.001, 5);
  });

  it.each(ANGLES)('keeps every vertex of a 10 m radius arc at 1 m segments at 100 m (rotated %d°)', async (angle) => {
    // Curved wall: 10 m inner radius, 0.2 m thick, 0.6 rad sweep in 6 segments
    // (1 m chords bow ~12 mm). 7 vertices per face, 14 real ring vertices.
    const segments = 6;
    const sweep = 0.6;
    const arc = (r: number): XZ[] =>
      Array.from({ length: segments + 1 }, (_, i) => {
        const t = (sweep * i) / segments;
        return [r * Math.cos(t), r * Math.sin(t)] as XZ;
      });
    const outline: XZ[] = [...arc(10), ...arc(10.2).reverse()];
    const ring = await cutRing(prismMesh(3, outline, outline, 3, angle, FAR));
    expect(ring).toHaveLength(outline.length);
  });
});
