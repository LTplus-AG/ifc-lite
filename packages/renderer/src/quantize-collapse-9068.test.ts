/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for #9068: the ~1 mm vertex lattice (#1682 phase 6) turned the
 * Ø2 mm rods of a 32 x 32 x 51 mm footing (a real IfcPolygonalFaceSet, in
 * metres) into jagged prisms. 382 of its 632 triangles collapsed. The same
 * class hits railing bars and thin pipes in the FZK-Haus and advanced_model
 * fixtures. Coordinates are deliberately off the 2^-10 lattice.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { createSceneBatch } from './scene-batch-upload.js';
import type { BatchQuantization } from './scene-derived-batches.js';
import { latticeCollapsesGeometry, MAX_COLLAPSED_AREA_FRACTION } from './quantize.js';
import { mergeGeometry } from './scene-geometry.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const OFF = [0.00031, 0.00047, 0.00013] as const;

function mesh(expressId: number, positions: number[], indices: number[]): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    indices: new Uint32Array(indices),
    color: GREY,
    origin: [0, 0, 0],
  };
}

/** Closed cylinder along Z: `segments` side quads plus two cap fans. */
function cylinder(cx: number, cy: number, z0: number, radius: number, height: number, segments = 16): { p: number[]; i: number[] } {
  const p: number[] = [], i: number[] = [];
  for (let s = 0; s < segments; s++) {
    const a = (2 * Math.PI * s) / segments;
    const x = OFF[0] + cx + radius * Math.cos(a), y = OFF[1] + cy + radius * Math.sin(a);
    p.push(x, y, OFF[2] + z0, x, y, OFF[2] + z0 + height);
  }
  const bottom = p.length / 3, top = bottom + 1;
  p.push(OFF[0] + cx, OFF[1] + cy, OFF[2] + z0, OFF[0] + cx, OFF[1] + cy, OFF[2] + z0 + height);
  for (let s = 0; s < segments; s++) {
    const a = 2 * s, b = 2 * ((s + 1) % segments);
    i.push(a, b, b + 1, a, b + 1, a + 1, bottom, b, a, top, a + 1, b + 1);
  }
  return { p, i };
}

/** Axis-aligned box from (x0, y0, z0) to (x1, y1, z1), 12 triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { p: number[]; i: number[] } {
  const p: number[] = [];
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) p.push(OFF[0] + x, OFF[1] + y, OFF[2] + z);
  const i = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { p, i };
}

function join(parts: { p: number[]; i: number[] }[]): { p: number[]; i: number[] } {
  const p: number[] = [], i: number[] = [];
  for (const part of parts) { const base = p.length / 3; p.push(...part.p); i.push(...part.i.map((k) => k + base)); }
  return { p, i };
}

/** The reported footing, reduced: a 32 x 32 mm block with four Ø2 mm rods. */
function footing(expressId: number, scale = 1): MeshData {
  const s = scale;
  const parts = [box(-0.016 * s, -0.016 * s, -0.027 * s, 0.016 * s, 0.016 * s, 0.0)];
  for (const [x, y] of [[-0.011, -0.011], [0.011, -0.011], [-0.011, 0.011], [0.011, 0.011]]) {
    parts.push(cylinder(x * s, y * s, 0, 0.001 * s, 0.024 * s));
  }
  const { p, i } = join(parts);
  return mesh(expressId, p, i);
}

/** A 5 m x 3 m x 0.2 m wall plus one sub-millimetre sliver: everyday geometry. */
function wallWithSliver(expressId: number): MeshData {
  const { p, i } = join([box(0, 0, 0, 5, 0.2, 3), { p: [1, 0.2, 1, 1.0002, 0.2, 1, 1, 0.2, 1.0003], i: [0, 1, 2] }]);
  return mesh(expressId, p, i);
}

const STRIDE = 7;
function collapses(...meshes: MeshData[]): boolean {
  const merged = mergeGeometry(meshes, [0, 0, 0]);
  return latticeCollapsesGeometry(merged.vertexData, STRIDE, merged.indices);
}

function fakeDevice(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}
const fakePipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as Parameters<typeof createSceneBatch>[3];
function batch(meshes: MeshData[], quantized: BatchQuantization) {
  return createSceneBatch(meshes, GREY, fakeDevice(), fakePipeline, { id: 0, colorKey: 'k', origin: [0, 0, 0], quantized, lod: false });
}

describe('lattice collapse guard (#9068)', () => {
  it('flags the Ø2 mm rods of the reported footing', () => {
    assert.strictEqual(collapses(footing(1)), true);
  });

  it('keeps everyday geometry with a sub-millimetre sliver quantized', () => {
    assert.strictEqual(collapses(wallWithSliver(1)), false);
  });

  it('is scale-relative: the same footing at 10x (Ø20 mm rods) survives the lattice', () => {
    assert.strictEqual(collapses(footing(1, 10)), false);
  });

  it('judges each entity on its own area, so a large neighbour cannot dilute a collapsed one', () => {
    const walls = Array.from({ length: 20 }, (_, k) => wallWithSliver(100 + k));
    assert.strictEqual(collapses(...walls), false, 'sanity: the walls alone quantize');
    assert.strictEqual(collapses(...walls, footing(1)), true);
    assert.ok(MAX_COLLAPSED_AREA_FRACTION > 0 && MAX_COLLAPSED_AREA_FRACTION < 0.05);
  });

  it('an auto batch holding the footing stays f32; an everyday batch still quantizes', () => {
    assert.strictEqual(batch([footing(1), wallWithSliver(2)], 'auto').quantized, undefined);
    assert.ok(batch([wallWithSliver(2)], 'auto').quantized, 'the memory win is kept where the lattice is harmless');
  });

  it('a required (derived) batch keeps its source decision, so depth coincidence is unchanged (#4832)', () => {
    assert.ok(batch([footing(1)], 'required').quantized);
  });
});
