/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for #11444: an IfcSweptDiskSolid rebar (Ø12 mm, 24 sides) along
 * a faceted IfcIndexedPolyCurve drew with crumpled bends and a non-round
 * section. The kernel's tube is round; the ~1 mm vertex lattice is not. No
 * triangle collapses there, so the #9068 guard let the batch quantize, but 10
 * to 30% of the surface turns its face by more than 20°, and the shader shades
 * each face by its snapped normal. Scene routing now keeps such a mesh in an
 * f32 bucket of its own, so the rest of its colour stays quantized.
 *
 * The bar is the issue's directrix (36 points, millimetres, two bends of 16
 * segments around a 22 mm centreline radius, an inclined middle leg), swept
 * the way the kernel sweeps it: 24-vertex rings carried along by a
 * rotation-minimising frame.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { latticeCollapsesGeometry } from './quantize.js';
import { markOffLattice } from './scene-bucket-routing.js';
import { mergeGeometry } from './scene-geometry.js';
import { Scene } from './scene.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const DIRECTRIX_MM: [number, number, number][] = [
  [0, 0, 0], [-420.5, 0, 0], [-422.6564, -0.0105, -0.1054],
  [-424.792, -0.0421, -0.4206], [-426.8863, -0.0943, -0.9426], [-428.919, -0.1666, -1.6663],
  [-430.8707, -0.2585, -2.5848], [-432.7225, -0.3689, -3.6893], [-434.4567, -0.4969, -4.969],
  [-436.0563, -0.6412, -6.4117], [-437.5062, -0.8003, -8.0034], [-438.7923, -0.9729, -9.7289],
  [-439.9023, -1.1572, -11.5716], [-440.8253, -1.3514, -13.5136], [-441.5527, -1.5536, -15.5362],
  [-442.0773, -1.762, -17.6201], [-442.3941, -1.9745, -19.7451], [-442.5, -2.1891, -21.8908],
  [-442.5, -8.2588, -82.5881], [-442.3941, -8.4734, -84.7338], [-442.0773, -8.6859, -86.8588],
  [-441.5527, -8.8943, -88.9427], [-440.8253, -9.0965, -90.9653], [-439.9023, -9.2907, -92.9073],
  [-438.7923, -9.475, -94.75], [-437.5062, -9.6475, -96.4755], [-436.0563, -9.8067, -98.0672],
  [-434.4567, -9.951, -99.5099], [-432.7225, -10.079, -100.7896], [-430.8707, -10.1894, -101.8941],
  [-428.919, -10.2813, -102.8126], [-426.8863, -10.3536, -103.5363], [-424.792, -10.4058, -104.0583],
  [-422.6564, -10.4373, -104.3735], [-420.5, -10.4479, -104.4789], [0, -10.4479, -104.4789],
];

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** A tube of `radius` metres and `sides` sides along `points` (metres), offset by `off`; no caps. */
function sweptBar(expressId: number, points: V[], radius: number, sides: number, off: V): MeshData {
  const n = points.length;
  const tangents = points.map((_, i) => unit(sub(points[Math.min(i + 1, n - 1)], points[Math.max(i - 1, 0)])));
  // First frame from a fixed up, then carried along: the previous perp1 projected off the new tangent.
  let perp1 = unit(cross(tangents[0], Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const along = dot(perp1, t);
    perp1 = unit([perp1[0] - t[0] * along, perp1[1] - t[1] * along, perp1[2] - t[2] * along]);
    const perp2 = cross(t, perp1);
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides;
      const r: V = [0, 1, 2].map((k) => Math.cos(a) * perp1[k] + Math.sin(a) * perp2[k]) as V;
      positions.push(...[0, 1, 2].map((k) => off[k] + points[i][k] + radius * r[k]));
      normals.push(...r);
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s, b = i * sides + ((s + 1) % sides);
      indices.push(a, b + sides, a + sides, a, b, b + sides);
    }
  }
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    color: [0.5, 0.5, 0.5, 1],
    origin: [0, 0, 0],
  };
}

/** A 5 m x 0.2 m x 3 m wall, off the lattice: everyday geometry the lattice keeps. */
function wall(expressId: number): MeshData {
  const off: V = [0.00031, 0.00047, 0.00013];
  const positions: number[] = [];
  for (const z of [0, 3]) for (const y of [0, 0.2]) for (const x of [0, 5]) positions.push(off[0] + x, off[1] + y, off[2] + z);
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.map((_, i) => (i % 3 === 2 ? 1 : 0))),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]),
    color: [0.5, 0.5, 0.5, 1],
    origin: [0, 0, 0],
  };
}

function fakeDevice(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}
const fakePipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];

/** Each batch of a quantized scene holding `meshes`: its entities and whether it quantized. */
function sceneBatches(meshes: MeshData[], recolour?: Map<number, [number, number, number, number]>): { ids: number[]; quantized: boolean }[] {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  scene.appendToBatches(meshes, fakeDevice(), fakePipeline);
  if (recolour) scene.updateMeshColors(recolour, fakeDevice(), fakePipeline);
  return scene.getBatchedMeshes()
    .map((batch) => ({ ids: [...batch.expressIds].sort((a, b) => a - b), quantized: batch.quantized !== undefined }))
    .sort((a, b) => a.ids[0] - b.ids[0]);
}

/** One colour-merged mesh holding `parts`, each part's vertices laned by its id (`entityIds`). */
function colourMerged(...parts: MeshData[]): MeshData {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], lanes: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions); normals.push(...part.normals);
    indices.push(...[...part.indices].map((i) => i + base));
    lanes.push(...Array.from({ length: part.positions.length / 3 }, () => part.expressId));
  }
  return { ...parts[0], positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), entityIds: new Uint32Array(lanes) };
}

const metres = DIRECTRIX_MM.map(([x, y, z]): V => [x / 1000, y / 1000, z / 1000]);
const STRIDE = 7;
function degrades(...meshes: MeshData[]): boolean {
  const merged = mergeGeometry(meshes, [0, 0, 0]);
  return latticeCollapsesGeometry(merged.vertexData, STRIDE, merged.indices);
}

describe('lattice turn guard (#11444)', () => {
  it('keeps the reported Ø12 mm bar off the lattice, wherever it sits on it', () => {
    // 32 fixed, unrelated offsets of up to a metre: the bar's share of turned faces
    // depends on where its vertices fall between lattice nodes.
    let seed = 11444;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    const offsets: V[] = [[0, 0, 0], ...Array.from({ length: 31 }, (): V => [2 * next(), 2 * next(), 2 * next()])];
    for (const off of offsets) {
      assert.strictEqual(degrades(sweptBar(1, metres, 0.006, 24, off)), true, `offset ${off}`);
    }
  });

  it('routes by the batch gate\'s rule, per entity', () => {
    const judge = (...meshes: MeshData[]): MeshData[] => {
      const off = new WeakSet<MeshData>();
      markOffLattice(meshes, () => 'grey', () => [0, 0, 0], off);
      return meshes.filter((mesh) => off.has(mesh));
    };
    const bar = sweptBar(1, metres, 0.006, 24, [0.00031, 0.00047, 0.00013]);
    const sameWall = { ...wall(2), expressId: 1 };
    assert.deepStrictEqual(judge(bar, wall(2)), [bar], 'only the bar leaves the lattice');
    assert.strictEqual(degrades(bar), true, 'the batch gate agrees');
    // The bar's own entity dilutes its loss across all its pieces of a colour, as the gate does.
    assert.deepStrictEqual(judge(bar, sameWall), [], 'an entity is judged whole');
    assert.strictEqual(degrades(bar, sameWall), false, 'and so is it at the gate');
  });

  it('keeps only the bar on f32: a wall of the same colour still quantizes', () => {
    const bar = sweptBar(1, metres, 0.006, 24, [0.00031, 0.00047, 0.00013]);
    assert.deepStrictEqual(sceneBatches([wall(2)]), [{ ids: [2], quantized: true }], 'sanity: the wall alone quantizes');
    assert.deepStrictEqual(sceneBatches([bar, wall(2)]), [{ ids: [1], quantized: false }, { ids: [2], quantized: true }]);
  });

  it('judges a colour-merged mesh per entity lane, as the batch gate does', () => {
    const bar = sweptBar(1, metres, 0.006, 24, [0.00031, 0.00047, 0.00013]);
    const merged = colourMerged(bar, wall(3));
    const off = new WeakSet<MeshData>();
    markOffLattice([merged], () => 'grey', () => [0, 0, 0], off);
    assert.strictEqual(degrades(merged), true, 'the gate fails the bar lane');
    assert.strictEqual(off.has(merged), true, 'so routing keeps the merged mesh off the lattice');
  });

  it('keeps the bar in an f32 batch of its own after a recolour', () => {
    const bar = sweptBar(1, metres, 0.006, 24, [0.00031, 0.00047, 0.00013]);
    const red: [number, number, number, number] = [1, 0, 0, 1];
    const batches = sceneBatches([bar, wall(2), { ...wall(4), color: red }], new Map([[1, red]]));
    assert.deepStrictEqual(batches, [{ ids: [1], quantized: false }, { ids: [2], quantized: true }, { ids: [4], quantized: true }]);
  });

  it('is scale-relative: the same bar at 10x (Ø120 mm) still quantizes', () => {
    const large = DIRECTRIX_MM.map(([x, y, z]): V => [x / 100, y / 100, z / 100]);
    assert.strictEqual(degrades(sweptBar(1, large, 0.06, 24, [0.00031, 0.00047, 0.00013])), false);
  });
});
