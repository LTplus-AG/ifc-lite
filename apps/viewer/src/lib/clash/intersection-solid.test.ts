/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `computeClashIntersectionSolid` against the REAL wasm kernel (no mock —
 * the wasm binding's own contract, `isSolid` / `degenerateReason` /
 * `thicknessM` / `requiredM`, is exactly what the viewer's fallback UI reads,
 * so a mocked kernel would test our own assumptions about the contract
 * instead of the contract). Two fixtures: a deep box overlap (must resolve a
 * solid with the right volume) and two disjoint boxes (must fall back
 * cleanly with `no-overlap` and zero geometry).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync } from '@ifc-lite/wasm';
import { computeClashIntersectionSolid } from './intersection-solid.js';

// `intersection-solid.ts`'s own `init()` (the wasm-bindgen `--target web`
// default) resolves the .wasm binary via `fetch(new URL(..., import.meta.url))`,
// which needs a real HTTP/file fetch the browser provides and this Node test
// runner doesn't. `initSync` shares the SAME module-level `wasm` singleton
// (guarded by `if (wasm !== undefined) return wasm`), so pre-loading it here
// from disk — the same pattern `packages/wasm/test/*.test.mjs` uses — makes
// `computeClashIntersectionSolid`'s own `init()` call a no-op, and every other
// line of the wrapper under test runs unmodified.
before(() => {
  const wasmPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm',
  );
  initSync({ module: readFileSync(wasmPath) });
});

/** Flat triangle-list box mesh, 12 triangles, CCW-ish (winding doesn't matter to the kernel). */
function boxMesh(min: [number, number, number], max: [number, number, number]): { positions: Float32Array; indices: Uint32Array } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  // 8 corners.
  const p: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const positions = new Float32Array(p.flat());
  // 6 faces, 2 triangles each.
  const faces = [
    [0, 1, 2, 0, 2, 3], // bottom
    [4, 6, 5, 4, 7, 6], // top
    [0, 4, 5, 0, 5, 1], // front
    [1, 5, 6, 1, 6, 2], // right
    [2, 6, 7, 2, 7, 3], // back
    [3, 7, 4, 3, 4, 0], // left
  ];
  const indices = new Uint32Array(faces.flat());
  return { positions, indices };
}

describe('computeClashIntersectionSolid (real wasm)', () => {
  it('resolves a solid for a deep 1x1x1 m overlap between two 2x2x2 m boxes', async () => {
    const a = boxMesh([0, 0, 0], [2, 2, 2]);
    const b = boxMesh([1, 1, 1], [3, 3, 3]);
    const result = await computeClashIntersectionSolid(a.positions, a.indices, b.positions, b.indices);
    assert.equal(result.isSolid, true);
    if (!result.isSolid) return; // narrows for TS below
    assert.ok(result.positions.length >= 12, 'a solid has at least 4 vertices');
    assert.ok(result.indices.length >= 12, 'a solid has at least 4 triangles');
    // The overlap of [1,1,1]-[2,2,2] is an exact 1 m³ cube.
    assert.ok(Math.abs(result.volumeM3 - 1) < 1e-3, `expected ~1 m³, got ${result.volumeM3}`);
  });

  it('falls back cleanly (no solid, empty geometry) for two disjoint boxes', async () => {
    const a = boxMesh([0, 0, 0], [1, 1, 1]);
    const b = boxMesh([5, 5, 5], [6, 6, 6]);
    const result = await computeClashIntersectionSolid(a.positions, a.indices, b.positions, b.indices);
    assert.equal(result.isSolid, false);
    if (result.isSolid) return;
    assert.equal(result.reason, 'no-overlap');
  });

  it('reports empty-operand when one mesh has no triangles', async () => {
    const a = boxMesh([0, 0, 0], [1, 1, 1]);
    const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
    const result = await computeClashIntersectionSolid(a.positions, a.indices, empty.positions, empty.indices);
    assert.equal(result.isSolid, false);
    if (result.isSolid) return;
    assert.equal(result.reason, 'empty-operand');
  });
});
