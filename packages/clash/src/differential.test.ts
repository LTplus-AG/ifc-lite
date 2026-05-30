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
import type { ClashElement, ClashResult, ClashRule, Vec3 } from './types.js';

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
});
