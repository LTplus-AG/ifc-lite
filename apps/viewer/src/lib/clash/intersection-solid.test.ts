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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
//
// The binary is a BUILD artifact (`bash scripts/build-wasm.sh`), not one of
// the `tests/models/` fixtures `pnpm fixtures` downloads — same distinction
// `packages/wasm/test/*.test.mjs` draws. Checked and skipped inside each
// `it`, not a top-level `before()`, so a missing binary skips every case
// individually instead of throwing before the suite's first test even starts.
//
// This skips rather than throws, unlike `packages/clash/src/engine-ts/obb.test.ts`
// (a vitest suite reconciled against this one after CodeRabbit raised the
// same "handle a missing WASM artifact" finding on both PRs). That is not a
// contradiction — it's a difference in what "skip" costs per runner. `node:test`
// (this file) prints `# SKIP <reason>` per test in its default TAP reporter, so
// the reason stays visible with no extra flags (verified against
// `packages/wasm/test/*.test.mjs`, which uses this exact pattern). vitest's
// default reporter prints only a bare "N skipped" count with the reason
// invisible unless you pass `--reporter=verbose`, which is why the vitest
// suite fails loudly instead. Either way the missing-artifact branch is dead
// in CI: `.github/workflows/test.yml`'s `build` job uploads the wasm runtime
// with `if-no-files-found: error`, and `node-tests` (which runs this suite)
// needs `build` to succeed first.
const wasmPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm',
);

/** Pure so the skip path is directly testable without touching the real filesystem. */
function wasmSkipReason(path: string): string | null {
  return existsSync(path) ? null : 'wasm bundle not built — run `bash scripts/build-wasm.sh` first';
}

let wasmReady = false;
function ensureWasm(t: { skip: (msg: string) => void }): boolean {
  if (wasmReady) return true;
  const reason = wasmSkipReason(wasmPath);
  if (reason) {
    t.skip(reason);
    return false;
  }
  initSync({ module: readFileSync(wasmPath) });
  wasmReady = true;
  return true;
}

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

describe('wasm-missing skip reason (deterministic, no real filesystem dependency)', () => {
  it('returns an actionable message pointing at build-wasm.sh when the binary is absent', () => {
    const missingPath = join(dirname(fileURLToPath(import.meta.url)), '__no-such-wasm-runtime__.wasm');
    assert.equal(wasmSkipReason(missingPath), 'wasm bundle not built — run `bash scripts/build-wasm.sh` first');
  });

  it('returns null when the binary is present', () => {
    assert.equal(wasmSkipReason(fileURLToPath(import.meta.url)), null);
  });
});

describe('computeClashIntersectionSolid (real wasm)', () => {
  it('resolves a solid for a deep 1x1x1 m overlap between two 2x2x2 m boxes', async (t) => {
    if (!ensureWasm(t)) return;
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

  it('falls back cleanly (no solid, empty geometry) for two disjoint boxes', async (t) => {
    if (!ensureWasm(t)) return;
    const a = boxMesh([0, 0, 0], [1, 1, 1]);
    const b = boxMesh([5, 5, 5], [6, 6, 6]);
    const result = await computeClashIntersectionSolid(a.positions, a.indices, b.positions, b.indices);
    assert.equal(result.isSolid, false);
    if (result.isSolid) return;
    assert.equal(result.reason, 'no-overlap');
  });

  it('reports empty-operand when one mesh has no triangles', async (t) => {
    if (!ensureWasm(t)) return;
    const a = boxMesh([0, 0, 0], [1, 1, 1]);
    const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) };
    const result = await computeClashIntersectionSolid(a.positions, a.indices, empty.positions, empty.indices);
    assert.equal(result.isSolid, false);
    if (result.isSolid) return;
    assert.equal(result.reason, 'empty-operand');
  });

  it('reports malformed-operand when an index points past its own operand', async (t) => {
    if (!ensureWasm(t)) return;
    const a = boxMesh([0, 0, 0], [2, 2, 2]);
    const b = boxMesh([1, 1, 1], [3, 3, 3]);
    // Deeply overlapping pair — so the ONLY thing that can make this degenerate
    // is the malformation, not the geometry. Point one index past the end of
    // B's own vertex list: the kernel's `mesh_from` rejects the whole operand
    // rather than silently dropping the triangle.
    const badIndices = Uint32Array.from(b.indices);
    badIndices[0] = b.positions.length / 3;
    const result = await computeClashIntersectionSolid(a.positions, a.indices, b.positions, badIndices);
    assert.equal(result.isSolid, false);
    if (result.isSolid) return;
    assert.equal(result.reason, 'malformed-operand');
  });
});

/**
 * The reason strings cross the wasm boundary as an untyped string and are cast
 * (`as ClashSolidDegenerateReason`) on arrival, so TypeScript cannot catch a
 * union that has drifted from the kernel. `'malformed-operand'` was missing for
 * exactly that reason: it is produced by the BINDING's own operand validation
 * (`mesh_from`), not by the geometry crate's `DegenerateReason` enum the union's
 * doc comment says it mirrors — so mirroring the enum silently missed it.
 *
 * This reads both sources and asserts the two sets are equal, in BOTH
 * directions: a reason added on the Rust side without a union member fails
 * here, and so does a phantom union member the kernel can never emit.
 */
describe('ClashSolidDegenerateReason ↔ clash_solid.rs parity', () => {
  const rustPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', 'rust', 'wasm-bindings', 'src', 'api', 'clash_solid.rs',
  );
  const tsPath = join(dirname(fileURLToPath(import.meta.url)), 'intersection-solid.ts');

  /** Every non-empty `reason` string literal the binding can assign, from its
   *  CODE only — comments are stripped first so prose can never satisfy this. */
  function kernelReasons(rustSource: string): Set<string> {
    const testMod = rustSource.indexOf('#[cfg(test)]');
    const code = (testMod === -1 ? rustSource : rustSource.slice(0, testMod))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const found = new Set<string>();
    // `reason: "malformed-operand"` — the binding-level rejections.
    for (const m of code.matchAll(/reason:\s*"([a-z-]+)"/g)) found.add(m[1]);
    // `DegenerateReason::NoOverlap => ("no-overlap", …)` — the enum mapping,
    // including the braced `BelowKernelResolution { … } => (…)` arm.
    for (const m of code.matchAll(/DegenerateReason::\w+(?:\s*\{[^}]*\})?\s*=>\s*\(\s*"([a-z-]+)"/g)) {
      found.add(m[1]);
    }
    return found;
  }

  /** The union's members, read from the .ts SOURCE — a type is erased at runtime.
   *  Comments are stripped first, symmetrically with `kernelReasons`, so a
   *  member named only in a doc comment cannot stand in for a real one. */
  function declaredReasons(tsSource: string): Set<string> {
    const code = tsSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const block = /export type ClashSolidDegenerateReason =([\s\S]*?);/.exec(code);
    assert.ok(block, 'ClashSolidDegenerateReason declaration not found');
    return new Set([...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  }

  it('declares exactly the reasons the kernel can emit', () => {
    const kernel = kernelReasons(readFileSync(rustPath, 'utf8'));
    const declared = declaredReasons(readFileSync(tsPath, 'utf8'));
    // Neither extractor may come back empty — two empty sets are "equal" and
    // would turn this into a test that passes by finding nothing.
    assert.ok(kernel.size > 0, 'no reason strings extracted from clash_solid.rs');
    assert.ok(declared.size > 0, 'no members extracted from the union');
    assert.deepEqual(
      [...declared].sort(),
      [...kernel].sort(),
      'ClashSolidDegenerateReason has drifted from clash_solid.rs',
    );
  });

  it('extracts nothing from a comment that merely mentions a reason', () => {
    assert.deepEqual([...kernelReasons('    // - `"invented-reason"` — prose only.\n')], []);
    assert.deepEqual(
      [...declaredReasons(
        "export type ClashSolidDegenerateReason =\n  /** prose about 'invented-reason' */\n  | 'no-overlap';",
      )],
      ['no-overlap'],
    );
  });
});
