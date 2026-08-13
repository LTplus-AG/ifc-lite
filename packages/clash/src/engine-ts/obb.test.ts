/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Analytic-oracle tests for the hard-clash depth metric — the deliverable a
 * PR #2536 hold comment asked for: "a real depth metric ... plus an
 * analytic-oracle test (two boxes at a known overlap, asserted at several
 * tessellations, so a sampling artifact cannot pass)".
 *
 * The held metric, `TriMesh.maxPenetrationInto` (removed), measured the
 * distance from the nearest crossing-triangle VERTEX to the other surface —
 * an O(edge length) sampling artifact that converges to 0 under
 * retessellation. The maintainer's fixture: two 2x2x2 boxes overlapping
 * exactly 1.5 m, tessellated at 12/48/192 triangles:
 *
 * | tris/elem | main     | held PR            | true     |
 * |-----------|----------|---------------------|----------|
 * | 12        | 1.500000 | 0.030000 `'mesh'`   | 1.500000 |
 * | 48        | 1.500000 | 0.500000 `'mesh'`   | 1.500000 |
 * | 192       | 1.500000 | 0.070000 `'mesh'`   | 1.500000 |
 *
 * `it.each` below reproduces that table bit-for-bit against the OLD metric
 * (skipped/kept as a historical record via `oldMaxPenetrationInto`, a local
 * reimplementation — the production method was deleted, see `tri-mesh.ts`)
 * and proves the NEW metric (`obbPenetrationDepth`, see `obb.ts`) reports the
 * true 1.5 m at every tessellation, in both the TS and the WASM/Rust kernel.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';
import { detectObb, obbPenetrationDepth } from './obb.js';
import { createClashEngine } from '../engine.js';
import { WasmClashEngine, initClashWasm } from '../engine-wasm/index.js';
import { triTriIntersect } from '../math/triangle-intersect.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';

let nextRef = 1;

/**
 * Axis-aligned box subdivided into an `n x n` grid per face (`6 * 2 * n^2`
 * triangles, closed, watertight). `n = 1, 2, 4` gives 12, 48, 192 triangles —
 * the maintainer's three tessellations — without changing the box's actual
 * geometry, so the true penetration depth of any two such boxes never
 * changes with `n`; only a sampling-based metric would.
 */
function subdividedBox(key: string, tag: string, min: Vec3, max: Vec3, n: number): ClashElement {
  const positions: number[] = [];
  const indices: number[] = [];
  const pushVertex = (p: Vec3) => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  function face(corner: Vec3, u: Vec3, v: Vec3) {
    const grid: number[][] = [];
    for (let i = 0; i <= n; i += 1) {
      grid.push([]);
      for (let j = 0; j <= n; j += 1) {
        const p: Vec3 = [
          corner[0] + (u[0] * i) / n + (v[0] * j) / n,
          corner[1] + (u[1] * i) / n + (v[1] * j) / n,
          corner[2] + (u[2] * i) / n + (v[2] * j) / n,
        ];
        grid[i].push(pushVertex(p));
      }
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const a = grid[i][j];
        const b = grid[i + 1][j];
        const c = grid[i + 1][j + 1];
        const d = grid[i][j + 1];
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const dx: Vec3 = [x1 - x0, 0, 0];
  const dy: Vec3 = [0, y1 - y0, 0];
  const dz: Vec3 = [0, 0, z1 - z0];
  face([x0, y0, z0], dy, dx); // -z
  face([x0, y0, z1], dx, dy); // +z
  face([x0, y0, z0], dx, dz); // -y
  face([x0, y1, z0], dz, dx); // +y
  face([x0, y0, z0], dz, dy); // -x
  face([x1, y0, z0], dy, dz); // +x
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    bounds: { min, max },
  };
}

const RULE: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' };

function pair(a: ClashElement, b: ClashElement) {
  const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), RULE, 0.001);
  if (!res) throw new Error('expected a clash');
  return res;
}

/**
 * Local reimplementation of the REMOVED `TriMesh.maxPenetrationInto`: the
 * maximum distance-to-surface of `other`, measured at the crossing-triangle
 * vertices of `mesh` that lie inside `other`. This is the exact artifact PR
 * #2536 was held for — reproduced here (not in production code) purely to
 * prove the analytic-oracle fixtures below actually exercise the failure
 * mode the maintainer measured, before proving the replacement metric fixes
 * it.
 */
function oldMaxPenetrationInto(mesh: TriMesh, other: TriMesh, crossFlags: Uint8Array): number {
  let depth = 0;
  for (let t = 0; t < mesh.count; t += 1) {
    if (crossFlags[t] === 0) continue;
    for (const v of mesh.tri(t)) {
      if (!other.containsPoint(v)) continue;
      const d = other.distanceToSurface(v);
      if (d > depth) depth = d;
    }
  }
  return depth;
}

/**
 * The maintainer's three tessellations, keyed by the resulting triangle
 * count (12/48/192), map to `subdividedBox`'s per-face grid subdivision
 * (1/2/4 — `6 * 2 * n^2` triangles). Keeping the test tables keyed by
 * triangle count (matching the hold-comment table verbatim) while driving
 * mesh construction off the grid factor, not the triangle count itself.
 */
const GRID_FOR_TRIS: Record<number, number> = { 12: 1, 48: 2, 192: 4 };

/** Reproduce the maintainer's fixture: two 2x2x2 boxes, one offset so the X
 * overlap is exactly 1.5 m, with a small Y/Z offset (0.03, 0.07) so the
 * contact is a genuine triangle crossing, not a flush coplanar touch — this
 * is what makes `oldMaxPenetrationInto`'s vertex probe fire on a real vertex
 * instead of hitting the (already-correct-for-boxes) coplanar-overlap
 * fallback. Returns the crossing flags alongside the meshes so both the old
 * and new metrics can be evaluated on the identical geometry. */
function heldFixture(triCount: number) {
  const grid = GRID_FOR_TRIS[triCount];
  const a = subdividedBox('A', 'X', [0, 0, 0], [2, 2, 2], grid);
  const b = subdividedBox('B', 'Y', [0.5, 0.03, 0.07], [2.5, 2.03, 2.07], grid);
  const meshA = new TriMesh(a.positions!, a.indices!);
  const meshB = new TriMesh(b.positions!, b.indices!);
  expect(meshA.count).toBe(triCount);
  return { a, b, meshA, meshB };
}

describe('analytic oracle: the held sampling artifact (reproduction)', () => {
  // The maintainer's exact table (PR #2536 hold comment, 2026-08-11).
  it.each([
    [12, 0.03],
    [48, 0.5],
    [192, 0.07],
  ])('at %i triangles, the OLD metric reports %f instead of 1.5 (all mesh-labelled)', (n, expectedArtifact) => {
    const { a, b, meshA, meshB } = heldFixture(n);
    const res = pair(a, b);
    expect(res.status).toBe('hard');

    // Recompute the crossing flags the same way `testPair` does internally,
    // so the reproduction runs the identical geometry the held PR reported.
    const crossA = new Uint8Array(meshA.count);
    const crossB = new Uint8Array(meshB.count);
    for (let ta = 0; ta < meshA.count; ta += 1) {
      const [a0, a1, a2] = meshA.tri(ta);
      for (let tb = 0; tb < meshB.count; tb += 1) {
        const [b0, b1, b2] = meshB.tri(tb);
        if (triTriIntersect(a0, a1, a2, b0, b1, b2)) {
          crossA[ta] = 1;
          crossB[tb] = 1;
        }
      }
    }
    const oldDepth = Math.max(
      oldMaxPenetrationInto(meshA, meshB, crossA),
      oldMaxPenetrationInto(meshB, meshA, crossB),
    );
    expect(oldDepth).toBeCloseTo(expectedArtifact, 6);
    expect(oldDepth).not.toBeCloseTo(1.5, 1);
  });
});

describe('analytic oracle: box-box penetration depth is exact and tessellation-invariant', () => {
  it.each([12, 48, 192])('reports the true 1.5 m overlap at %i triangles/element, labelled mesh', (triCount) => {
    const grid = GRID_FOR_TRIS[triCount];
    const a = subdividedBox('A', 'IfcWall', [0, 0, 0], [2, 2, 2], grid);
    const b = subdividedBox('B', 'IfcWall', [0.5, 0.03, 0.07], [2.5, 2.03, 2.07], grid);
    expect(a.indices!.length / 3).toBe(triCount);
    const res = pair(a, b);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBeCloseTo(-1.5, 6);
  });

  it('is bit-identical across all three tessellations, not merely close', () => {
    const distances = [12, 48, 192].map((triCount) => {
      const grid = GRID_FOR_TRIS[triCount];
      const a = subdividedBox('A', 'IfcWall', [0, 0, 0], [2, 2, 2], grid);
      const b = subdividedBox('B', 'IfcWall', [0.5, 0.03, 0.07], [2.5, 2.03, 2.07], grid);
      return pair(a, b).distance;
    });
    expect(distances[0]).toBe(distances[1]);
    expect(distances[1]).toBe(distances[2]);
  });

  it('rejects a barely-overlapping control (5 mm) rather than inflating it', () => {
    // Control: the correct answer IS small. A metric that cheats by always
    // reporting something large (e.g. an AABB dimension of a nearby, much
    // bigger element) would fail this the same way it passes the 1.5 m case
    // for the wrong reason. 5 mm keeps the overlap comfortably above the
    // 1 mm default tolerance (so it registers as `'hard'`, not `'touch'`)
    // while staying two orders of magnitude below the 1.5 m case.
    const a = subdividedBox('A', 'IfcWall', [0, 0, 0], [2, 2, 2], 4);
    const b = subdividedBox('B', 'IfcWall', [1.995, 0, 0], [3.995, 2, 2], 4);
    const res = pair(a, b);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBeCloseTo(-0.005, 6);
  });

  it('reports the exact MTD for a box rotated 45 degrees about Z', () => {
    // A small cube (half-extent 0.3), rotated 45 degrees about Z, sitting
    // partly inside a large axis-aligned cube (half-extent 1) with a KNOWN,
    // independently-derived Z overlap of 0.15 m. The small cube's footprint,
    // even rotated, has a projected half-width of 0.3*sqrt(2) ~ 0.424 in any
    // XY direction — far short of reaching the large cube's XY boundary at
    // 1.0 from a centred XY position — so no XY-axis translation could
    // separate them in less than ~0.58 m. The Z axis is therefore trivially
    // the true minimum-translation-distance axis, independent of rotation,
    // giving a non-circular oracle value: this exercises the OBB detection
    // and 15-axis projection machinery on a genuinely rotated box without
    // relying on the SAT implementation to derive its own expected value.
    const big = subdividedBox('BIG', 'IfcWall', [-1, -1, -1], [1, 1, 1], 2);
    const half = 0.3;
    const cz = 1 + half - 0.15; // Z overlap with the big cube's z=1 face is 0.15
    const rot = rotatedCubeAboutZ('SMALL', 'IfcBeam', [0, 0, cz], half, Math.PI / 4);
    const res = pair(big, rot);
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBeCloseTo(-0.15, 6);
  });
});

/** A cube of half-extent `half` centred at `center`, rotated `angle` radians
 * about Z, baked directly into world-space triangle positions (not carried
 * as a transform) — `detectObb` reasons about world-space triangle normals,
 * so this must be a genuinely rotated mesh, not an axis-aligned one with a
 * deferred transform. */
function rotatedCubeAboutZ(key: string, tag: string, center: Vec3, half: number, angle: number): ClashElement {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const local: Vec3[] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const positions: number[] = [];
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of local) {
    const wx = c * x - s * y + center[0];
    const wy = s * x + c * y + center[1];
    const wz = z + center[2];
    positions.push(wx, wy, wz);
    const p: Vec3 = [wx, wy, wz];
    for (let a = 0; a < 3; a += 1) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions: new Float32Array(positions), indices, bounds: { min, max } };
}

describe('analytic oracle: detectObb / obbPenetrationDepth unit behaviour', () => {
  it('detects a plain axis-aligned box regardless of tessellation', () => {
    // `detectObb` discovers axes in triangle-traversal order, not fixed x/y/z
    // order, so compare the half-extents/center as sets, not positional
    // arrays — the box's true half-extents are {1, 1.5, 2}.
    for (const n of [1, 2, 4]) {
      const el = subdividedBox('A', 'X', [0, 0, 0], [2, 3, 4], n);
      const mesh = new TriMesh(el.positions!, el.indices!);
      const obb = detectObb(mesh);
      expect(obb).not.toBeNull();
      expect([...obb!.half].sort((x, y) => x - y)).toEqual([1, 1.5, 2]);
      expect(obb!.center).toEqual([1, 1.5, 2]);
    }
  });

  it('declines a non-box (triangular prism)', () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 0, 1, 1,
    ]);
    const indices = new Uint32Array([
      0, 1, 2, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5,
    ]);
    const mesh = new TriMesh(positions, indices);
    expect(detectObb(mesh)).toBeNull();
  });

  it('declines an axis-aligned L-shape (3 face-normal families, but a 3rd offset plane on two axes)', () => {
    // Footprint (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2), extruded z=0..1.
    const positions = new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
      0, 0, 1, 2, 0, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 0, 2, 1,
    ]);
    const indices = new Uint32Array([
      0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4,
      6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11,
      0, 1, 7, 0, 7, 6, 1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8,
      3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11, 10, 5, 0, 6, 5, 6, 11,
    ]);
    const mesh = new TriMesh(positions, indices);
    expect(detectObb(mesh)).toBeNull();
  });

  it('declines an open shell (5 faces, no top) instead of certifying a zero-thickness box', () => {
    // Review, #2536: a face family whose triangles are all coplanar passes
    // the 2-plane test (`minOff == maxOff`, so both `nearMin` and `nearMax`
    // hold trivially) — a slab exported without its top face, or partial
    // `IfcTriangulatedFaceSet` geometry, produces exactly this: 3 orthogonal
    // face-normal families (bottom, and the 4 sides split into an X and a Y
    // family), but the "top" family has only the bottom's single plane, so
    // the resulting Z half-extent is 0. Nothing checked that before.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // 0-3: bottom ring, z=0
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // 4-7: top ring, z=1 (rim only, no cap)
    ]);
    const indices = new Uint32Array([
      0, 2, 1, 0, 3, 2, // bottom cap only — no top cap (4,5,6)/(4,6,7)
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ]);
    const mesh = new TriMesh(positions, indices);
    expect(detectObb(mesh)).toBeNull();
  });

  it('obbPenetrationDepth returns null (not a wrong number) for boxes that do not actually overlap', () => {
    const a = subdividedBox('A', 'X', [0, 0, 0], [1, 1, 1], 1);
    const b = subdividedBox('B', 'Y', [5, 5, 5], [6, 6, 6], 1);
    const meshA = new TriMesh(a.positions!, a.indices!);
    const meshB = new TriMesh(b.positions!, b.indices!);
    const obbA = detectObb(meshA);
    const obbB = detectObb(meshB);
    expect(obbA).not.toBeNull();
    expect(obbB).not.toBeNull();
    expect(obbPenetrationDepth(obbA!, obbB!)).toBeNull();
  });
});

describe('analytic oracle: TS/WASM kernel parity on the held fixture', () => {
  const ts = createClashEngine({ backend: 'ts' });
  const wasm = new WasmClashEngine();

  beforeAll(async () => {
    const wasmPath = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
    await initClashWasm(readFileSync(wasmPath));
  });

  it.each([12, 48, 192])('both kernels report 1.5 m, labelled mesh, at %i triangles/element', async (triCount) => {
    const grid = GRID_FOR_TRIS[triCount];
    const a = subdividedBox('A', 'IfcWall', [0, 0, 0], [2, 2, 2], grid);
    const b = subdividedBox('B', 'IfcDuctSegment', [0.5, 0.03, 0.07], [2.5, 2.03, 2.07], grid);
    expect(a.indices!.length / 3).toBe(triCount);
    const rules: ClashRule[] = [{ id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' }];
    const resTs = await ts.run([a, b], rules);
    const resWasm = await wasm.run([a, b], rules);
    expect(resTs.clashes).toHaveLength(1);
    expect(resWasm.clashes).toHaveLength(1);
    expect(resTs.clashes[0].distanceKind).toBe('mesh');
    expect(resWasm.clashes[0].distanceKind).toBe('mesh');
    expect(resTs.clashes[0].distance).toBeCloseTo(-1.5, 6);
    expect(resWasm.clashes[0].distance).toBeCloseTo(-1.5, 6);
    expect(Math.abs(resTs.clashes[0].distance - resWasm.clashes[0].distance)).toBeLessThan(1e-6);
  });
});
