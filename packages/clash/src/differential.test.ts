/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Differential test: the Rust/WASM kernel must produce the same clashes as the
 * pure-TypeScript reference engine. Both run through the identical orchestrator,
 * so any divergence is in the geometry kernel. We assert identical clash sets
 * (by id), status and severity, with distances and points within epsilon
 * (f64 summation order can differ by ~1e-12 across the two implementations).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createClashEngine } from './engine.js';
import { disciplineMatrixRules } from './disciplines.js';
import { WasmClashEngine, initClashWasm } from './engine-wasm/index.js';
import type { ClashElement, ClashResult, ClashRule, Mat4, Vec3 } from './types.js';

const EPS = 1e-6;

function makeBox(center: Vec3, size: number): { positions: Float32Array; indices: Uint32Array } {
  const h = size / 2;
  const [cx, cy, cz] = center;
  const v = [
    cx - h, cy - h, cz - h, cx + h, cy - h, cz - h, cx + h, cy + h, cz - h, cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h, cx + h, cy - h, cz + h, cx + h, cy + h, cz + h, cx - h, cy + h, cz + h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return { positions: new Float32Array(v), indices };
}

let refCounter = 1;
function box(key: string, tag: string, center: Vec3, size = 1): ClashElement {
  const { positions, indices } = makeBox(center, size);
  const h = size / 2;
  return {
    key,
    ref: refCounter++,
    model: 'm',
    tag,
    positions,
    indices,
    bounds: {
      min: [center[0] - h, center[1] - h, center[2] - h],
      max: [center[0] + h, center[1] + h, center[2] + h],
    },
  };
}

const BOX_CORNER_ORDER: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const BOX_IDX = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
]);

/** Box element with per-axis half-extents (world positions, no transform). */
function boxHxyz(key: string, tag: string, center: Vec3, half: Vec3): ClashElement {
  const v: number[] = [];
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [sx, sy, sz] of BOX_CORNER_ORDER) {
    const p: Vec3 = [center[0] + sx * half[0], center[1] + sy * half[1], center[2] + sz * half[2]];
    v.push(...p);
    for (let a = 0; a < 3; a += 1) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
  }
  return { key, ref: refCounter++, model: 'm', tag, positions: new Float32Array(v), indices: BOX_IDX, bounds: { min, max } };
}

const PRISM_IDX = new Uint32Array([
  0, 1, 2, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5,
]);

/** Closed triangular prism: footprint (XY) extruded between z0 and z1. */
function triPrism(
  key: string,
  tag: string,
  footprint: [[number, number], [number, number], [number, number]],
  z0: number,
  z1: number,
): ClashElement {
  const [p0, p1, p2] = footprint;
  const v = [
    p0[0], p0[1], z0, p1[0], p1[1], z0, p2[0], p2[1], z0,
    p0[0], p0[1], z1, p1[0], p1[1], z1, p2[0], p2[1], z1,
  ];
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a += 1) { const c = v[i + a]; if (c < min[a]) min[a] = c; if (c > max[a]) max[a] = c; }
  }
  return { key, ref: refCounter++, model: 'm', tag, positions: new Float32Array(v), indices: PRISM_IDX, bounds: { min, max } };
}

function applyMat4Pt(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * A box that carries a deferred world `transform` (the federation hook on the
 * STEP adapter). World bounds are f32-quantized to mirror what both kernels
 * ultimately feed the narrow phase, isolating the transform-precision parity.
 */
function boxWithTransform(key: string, tag: string, center: Vec3, size: number, transform: Mat4): ClashElement {
  const { positions, indices } = makeBox(center, size);
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const w = applyMat4Pt(transform, positions[i], positions[i + 1], positions[i + 2]);
    for (let a = 0; a < 3; a += 1) {
      const v = Math.fround(w[a]);
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { key, ref: refCounter++, model: 'm', tag, positions, indices, bounds: { min, max }, transform };
}

const ts = createClashEngine({ backend: 'ts' });
const wasm = new WasmClashEngine();

function assertParity(a: ClashResult, b: ClashResult): void {
  expect(b.clashes.length).toBe(a.clashes.length);
  const byId = new Map(b.clashes.map((c) => [c.id, c]));
  for (const x of a.clashes) {
    const y = byId.get(x.id);
    expect(y, `clash ${x.id} should exist in the WASM result`).toBeDefined();
    if (!y) continue;
    expect(y.status).toBe(x.status);
    expect(y.severity).toBe(x.severity);
    expect(Math.abs(y.distance - x.distance)).toBeLessThan(EPS);
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(y.point[i] - x.point[i])).toBeLessThan(EPS);
    }
    // Tight-contact bounds must agree across backends too (#1402 Bug B), not just
    // count/status/point — otherwise a bounds regression in one kernel slips by.
    // Both kernels must also agree on whether bounds exist at all, so a one-sided
    // bounds regression cannot hide behind a presence check.
    expect(Boolean(y.bounds), `clash ${x.id} bounds presence must match`).toBe(Boolean(x.bounds));
    if (x.bounds && y.bounds) {
      for (let i = 0; i < 3; i += 1) {
        expect(Math.abs(y.bounds.min[i] - x.bounds.min[i])).toBeLessThan(EPS);
        expect(Math.abs(y.bounds.max[i] - x.bounds.max[i])).toBeLessThan(EPS);
      }
    }
  }
}

async function bothAgree(elements: ClashElement[], rules: ClashRule[]): Promise<number> {
  const a = await ts.run(elements, rules);
  const b = await wasm.run(elements, rules);
  assertParity(a, b);
  return a.clashes.length;
}

beforeAll(async () => {
  // Load the web-target wasm in Node by feeding the bytes directly.
  const wasmPath = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
  await initClashWasm(readFileSync(wasmPath));
});

describe('differential: WASM kernel === TS kernel', () => {
  it('agrees on a hard clash', async () => {
    const els = [box('A', 'IfcWall', [0, 0, 0]), box('B', 'IfcDuctSegment', [0.5, 0, 0])];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });

  it('agrees on clearance (inside and outside the gap)', async () => {
    const els = [box('A', 'IfcWall', [0, 0, 0]), box('B', 'IfcDuctSegment', [2, 0, 0])];
    expect(await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'clearance', clearance: 0.5 }])).toBe(0);
    expect(await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'clearance', clearance: 1.5 }])).toBe(1);
  });

  it('agrees on touch (suppressed and reported)', async () => {
    const els = [box('A', 'IfcWall', [0, 0, 0]), box('B', 'IfcDuctSegment', [1, 0, 0])];
    expect(await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }])).toBe(0);
    expect(await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard', reportTouch: true }])).toBe(1);
  });

  it('agrees on a self-clash', async () => {
    const els = [
      box('A', 'IfcBeam', [0, 0, 0]),
      box('B', 'IfcBeam', [0.5, 0, 0]),
      box('C', 'IfcBeam', [10, 0, 0]),
    ];
    expect(await bothAgree(els, [{ id: 'self', name: 'self', a: 'IfcBeam', mode: 'hard' }])).toBe(1);
  });

  it('agrees across the full discipline matrix on a mixed model', async () => {
    const els = [
      box('w1', 'IfcWall', [0, 0, 0]),
      box('d1', 'IfcDuctSegment', [0.4, 0, 0]),
      box('b1', 'IfcBeam', [0.4, 0, 0]),
      box('p1', 'IfcPipeSegment', [3, 0, 0]),
      box('c1', 'IfcColumn', [3.3, 0, 0]),
      box('s1', 'IfcSlab', [3.3, 0, 0]),
      box('cab', 'IfcCableSegment', [6, 0, 0]),
      box('p2', 'IfcPipeSegment', [6.3, 0, 0]),
    ];
    const n = await bothAgree(els, disciplineMatrixRules('hard'));
    expect(n).toBeGreaterThan(0);
  });

  it('agrees on a fully-enclosed solid (no surface crossing)', async () => {
    // A 1×1 duct centered inside a 10×10 wall: surfaces are 4.5 m apart so no
    // triangle pair is within margin — the only signal is full enclosure, which
    // both kernels must detect via the point-in-solid ray cast.
    const els = [box('OUT', 'IfcWall', [0, 0, 0], 10), box('IN', 'IfcDuctSegment', [0, 0, 0], 1)];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });

  it('agrees that disjoint solids are not a clash (enclosure must not over-fire)', async () => {
    const els = [box('A', 'IfcWall', [0, 0, 0], 1), box('B', 'IfcDuctSegment', [20, 0, 0], 1)];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(0);
  });

  it('agrees that skewed members sharing only a face are not a hard clash (#1362 Bug A)', async () => {
    const els = [
      triPrism('A', 'IfcWall', [[0, 0], [2, 0], [0, 2]], 0, 1),
      triPrism('B', 'IfcDuctSegment', [[2, 0], [0, 2], [5, 5]], 0, 1),
    ];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(0);
  });

  it('agrees that members that interpenetrate are a hard clash (#1362 recall)', async () => {
    const els = [
      triPrism('A', 'IfcWall', [[0, 0], [2, 0], [0, 2]], 0, 1),
      boxHxyz('B', 'IfcDuctSegment', [1, 1, 0.5], [0.5, 0.5, 0.5]),
    ];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });

  it('agrees on a genuine crossing (tight-contact path) (#1402 Bug B)', async () => {
    const els = [
      boxHxyz('A', 'IfcWall', [0, 0, 0], [5, 0.5, 0.5]),
      boxHxyz('B', 'IfcDuctSegment', [0, 0, 0], [0.5, 5, 0.5]),
    ];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });

  it('agrees on unequal-length aligned overlap (overlap-centre probe) (#1362)', async () => {
    // Long bar x[-5,5] and short bar x[4.9,5.9] sharing y/z extents: the centroid
    // midpoint falls outside the short bar, so both kernels must rely on the
    // AABB-overlap-centre probe and agree it is a hard clash.
    const els = [
      boxHxyz('A', 'IfcWall', [0, 0, 0], [5, 0.5, 0.5]),
      boxHxyz('B', 'IfcDuctSegment', [5.4, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });

  it('agrees on transformed elements (f32-quantized world coords)', async () => {
    // Rotate ~0.3 rad about Z + a large, non-f32-exact RTC-style translation: the
    // transformed coords are NOT f32-representable, so the WASM arena's f32 packing
    // and the TS kernel's transform must quantize identically (Math.fround) or the
    // contact point drifts by ~1e-4 at this scale — far beyond the 1e-6 parity EPS.
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const m: Mat4 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 1234.567, -89.0, 0.123, 1];
    // Same rigid transform on both boxes, which overlap locally → still overlap.
    const els = [
      boxWithTransform('A', 'IfcWall', [0, 0, 0], 1, m),
      boxWithTransform('B', 'IfcDuctSegment', [0.5, 0, 0], 1, m),
    ];
    const n = await bothAgree(els, [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }]);
    expect(n).toBe(1);
  });
});
