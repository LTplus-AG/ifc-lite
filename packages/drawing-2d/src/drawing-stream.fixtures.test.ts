/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only scenes for the streamed generator (#10264): every generator
 * stage has something to do, so a batch boundary that changed any of them
 * changes the output. Also run unchanged against the pre-streaming generator
 * to record `drawing-stream.golden.json`. A `.test.ts` so it never ships in `dist`.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { Drawing2D, SectionConfig } from './types.js';

type V3 = [number, number, number];

/** Outward-wound box between world corners; positions local to `origin`. */
export function box(expressId: number, min: V3, max: V3, extra: Partial<MeshData> = {}): MeshData {
  const o = extra.origin ?? [0, 0, 0];
  const [x0, y0, z0] = [min[0] - o[0], min[1] - o[1], min[2] - o[2]];
  const [x1, y1, z1] = [max[0] - o[0], max[1] - o[1], max[2] - o[2]];
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { expressId, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length), indices,
    color: [0.8, 0.8, 0.8, 1], ...extra };
}

/** A single-sided vertical sheet (free edges everywhere): an open surface (#8664). */
export function sheet(expressId: number, x0: number, x1: number, z: number, height: number): MeshData {
  const positions = new Float32Array([x0, 0, z, x1, 0, z, x1, height, z, x0, height, z]);
  return { expressId, ifcType: 'IfcCovering', modelIndex: 0, positions, normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]), color: [0.5, 0.5, 0.9, 1] };
}

/** A single-sided vertical quad from (xa, za) to (xb, zb), 0..height in y: part of an open shell. */
function wallQuad(xa: number, za: number, xb: number, zb: number, height: number): number[] {
  return [xa, 0, za, xb, 0, zb, xb, height, zb, xa, height, za];
}

/**
 * One open shell (#8664 review): a square tube of single-sided walls, open at both rims, as entity 20 with two
 * material layers. Each layer's cut is an open chain; only the two together close the loop. `corner` splits the
 * layers at two corners; `midwall` splits two walls in half, so the layers' section endpoints coincide mid-wall.
 * Each layer has its own vertices (coincident, not shared), as separate sub-meshes do.
 */
export function multiMaterialShell(split: 'corner' | 'midwall', height = 3): MeshData[] {
  const layer = (quads: number[][], materialId: number, color: [number, number, number, number]): MeshData => {
    const positions = new Float32Array(quads.flat());
    const indices = new Uint32Array(quads.flatMap((_, i) => [4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3]));
    return { expressId: 20, ifcType: 'IfcCovering', modelIndex: 0, positions, normals: new Float32Array(positions.length), indices,
      color, materialId };
  };
  const a = split === 'corner'
    ? [wallQuad(0, 0, 4, 0, height), wallQuad(0, 4, 0, 0, height)]
    : [wallQuad(0, 0, 2, 0, height), wallQuad(0, 4, 0, 0, height), wallQuad(2, 4, 0, 4, height)];
  const b = split === 'corner'
    ? [wallQuad(4, 0, 4, 4, height), wallQuad(4, 4, 0, 4, height)]
    : [wallQuad(2, 0, 4, 0, height), wallQuad(4, 0, 4, 4, height), wallQuad(4, 4, 2, 4, height)];
  return [layer(a, 41, [0.9, 0.2, 0.2, 1]), layer(b, 42, [0.2, 0.9, 0.2, 1])];
}

/** Walls, a two-layer wall, an RTC-origin slab, an open sheet, an occluded post, a second model, an opening. */
export function streamScene(): MeshData[] {
  return [
    box(1, [0, 0, 0], [10, 3, 0.3]),
    box(2, [0, 0, 0.3], [0.3, 3, 8]),
    // One entity, two material layers, split across two sub-meshes.
    box(3, [9.7, 0, 0.3], [9.85, 3, 8], { color: [0.9, 0.2, 0.2, 1], materialId: 31 }),
    box(3, [9.85, 0, 0.3], [10, 3, 8], { color: [0.2, 0.9, 0.2, 1], materialId: 32 }),
    // Far from the origin, carried by an f64 origin (RTC, #945).
    box(4, [0, -0.3, 0], [10, 0, 8], { ifcType: 'IfcSlab', origin: [5, -0.15, 4] }),
    sheet(5, 2, 6, 4, 2.5),
    // A post behind the wall seen from the front: hidden-line occlusion.
    box(6, [4, 0, -3], [4.4, 2, -2.6], { ifcType: 'IfcColumn' }),
    box(7, [3, 0, 0.5], [7, 1, 1], { ifcType: 'IfcFurnishingElement' }),
    // Federation: a second model, same express id as the first wall.
    box(1, [12, 0, 0], [15, 3, 0.3], { modelIndex: 1 }),
    box(8, [5, 1, -0.1], [6, 2, 0.4], { ifcType: 'IfcOpeningElement' }),
    box(9, [0, 2.5, 0], [10, 2.8, 8], { ifcType: 'IfcBeam' }),
  ];
}

const base: Omit<SectionConfig, 'plane'> = { projectionDepth: 6, includeHiddenLines: true, creaseAngle: 30, scale: 100 };

/** Plan, flipped section, banded section and a face-picked custom plane. */
export function streamConfigs(): Array<{ name: string; config: SectionConfig }> {
  return [
    { name: 'plan', config: { ...base, plane: { axis: 'y', position: 1.5, flipped: false } } },
    { name: 'section-front', config: { ...base, plane: { axis: 'z', position: 4, flipped: false } } },
    { name: 'section-flipped', config: { ...base, plane: { axis: 'z', position: 4, flipped: true } } },
    { name: 'plan-bands', config: { ...base, clipProjectionBands: true, projectionBelowDepth: 1.4, projectionAboveDepth: 1.4,
      plane: { axis: 'y', position: 1.5, flipped: false } } },
    { name: 'custom', config: { ...base, plane: { axis: 'z', position: 4, flipped: false, customPlane: {
      normal: { x: 0.6, y: 0, z: 0.8 }, distance: 4, origin: { x: 2.4, y: 0, z: 3.2 },
      tangent: { x: 0.8, y: 0, z: -0.6 }, bitangent: { x: 0, y: 1, z: 0 } } } } },
  ];
}

export const STREAM_OPTIONS = { useGPU: false, includeProjection: true, includeEdges: true, includeHiddenLines: true, mergeLines: true } as const;

/** Everything a drawing says except its wall-clock timing. */
export function drawingDigest(drawing: Drawing2D): string {
  const { stats, ...rest } = drawing;
  const { processingTimeMs: _timing, ...counts } = stats;
  const text = JSON.stringify({ ...rest, stats: counts }, (_key, value: unknown) =>
    value instanceof Set ? [...value] : value instanceof Map ? [...value] : value);
  return createHash('sha256').update(text).digest('hex');
}

describe('streamed generator scenes', () => {
  it('carry two models, an RTC origin, an open surface and a layered entity', () => {
    const scene = streamScene();
    expect(new Set(scene.map((mesh) => mesh.modelIndex))).toEqual(new Set([0, 1]));
    expect(scene.some((mesh) => mesh.origin)).toBe(true);
    expect(scene.filter((mesh) => mesh.expressId === 3)).toHaveLength(2);
    expect(scene.some((mesh) => mesh.ifcType === 'IfcCovering')).toBe(true);
  });
});
