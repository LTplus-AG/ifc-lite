/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World-frame fixture corpus.
 *
 * One defect class produced four defects in a single day, all invisible to
 * green CI (#2598 caught pre-merge, #2600 and #2529 merged live): code that
 * consumes mesh geometry either
 *
 *  1. reads raw `positions` as world coordinates, ignoring the per-element
 *     RTC `MeshData.origin` (local-frame is the DEFAULT on the wasm path:
 *     `rust/geometry/src/router/transforms/mod.rs` sets origin = element AABB
 *     centre, and a pure translation moves ONLY the origin), or
 *  2. sizes a plane-distance tolerance from the max |coordinate| over ALL
 *     THREE axes, then compares it against a signed distance along ONE plane
 *     normal — so a model 10 km out in X hands a Z-normal test a
 *     millimetre-scale epsilon derived entirely from the irrelevant X
 *     magnitude.
 *
 * No test in the repo fed those paths a mesh with a non-zero `origin` or with
 * large world coordinates; this corpus closes that gap. Its four cases:
 *
 *  - `'at-origin'`       counter-case: near the origin, no RTC origin. A "fix"
 *                        that simply widens every tolerance fails here.
 *  - `'far-baked'`       large world coordinates baked into f32 positions,
 *                        offset on ONE axis (default X). Tests of behaviour
 *                        along a DIFFERENT axis (a Z plane normal, a Z
 *                        clearance) catch max-over-axes overreach; an offset
 *                        on the tested axis itself would coincidentally agree
 *                        with the correct projection and prove nothing.
 *  - `'local-frame'`     positions element-local, `origin` carries the world
 *                        centre (the wasm default). Consumers reading raw
 *                        positions as world coordinates are wrong here.
 *  - `'far-local-frame'` both composed: far world centre carried in `origin`,
 *                        small local positions.
 *
 * All four place THE SAME element; a frame-correct consumer answers
 * identically (up to the f32 noise of the offset axis) across the corpus.
 *
 * The expected tolerance shape this corpus encodes is the one
 * `packages/drawing-2d/src/section-cutter.ts` (PR #2622) got right: f32 noise
 * in a distance along plane normal n is bounded by the NORMAL-PROJECTED ULP
 * sum `sum_i |n_i| * ulp32(extent_i)` over per-axis extents — never by
 * `max |coordinate|` over all axes. See {@link normalProjectedNoiseBound}.
 */

import type { MeshData } from '@ifc-lite/geometry';

export type Axis = 'x' | 'y' | 'z';
export const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** Far-from-origin offset magnitude (metres). 10 km: the f32 ULP there is
 *  ~0.98 mm, and a max-over-axes `extent * 2^-22` tolerance reads ~2.4 mm —
 *  the regime of every reproduced defect in the class. */
export const WORLD_FRAME_OFFSET_M = 10_000;

export type WorldFrameCase = 'at-origin' | 'far-baked' | 'local-frame' | 'far-local-frame';

/** The whole corpus, for `for..of` sweeps. */
export const WORLD_FRAME_CASES: readonly WorldFrameCase[] = [
  'at-origin',
  'far-baked',
  'local-frame',
  'far-local-frame',
];

/** A placed mesh in `MeshData`'s frame convention:
 *  world vertex i = `(origin ?? 0) + positions[3i..3i+3]`. */
export interface PlacedMesh {
  /** f32-quantized vertex buffer — exactly what a consumer ingests. */
  positions: Float32Array;
  /** RTC origin. Absent for the baked cases. */
  origin?: [number, number, number];
}

export interface PlaceOptions {
  frameCase: WorldFrameCase;
  /** Axis carrying the far offset. MUST differ from the axis under test
   *  (plane normal, clearance direction), or the fixture looks like coverage
   *  while proving nothing. Default `'x'`. */
  offsetAxis?: Axis;
  /** Far offset magnitude in metres. Default {@link WORLD_FRAME_OFFSET_M}. */
  offsetM?: number;
}

function offsetVec(opts: PlaceOptions): [number, number, number] {
  const v: [number, number, number] = [0, 0, 0];
  if (opts.frameCase === 'far-baked' || opts.frameCase === 'far-local-frame') {
    v[AXIS_INDEX[opts.offsetAxis ?? 'x']] = opts.offsetM ?? WORLD_FRAME_OFFSET_M;
  }
  return v;
}

/** AABB centre of a flat position buffer (f64 arithmetic). */
function aabbCentre(pos: ArrayLike<number>): [number, number, number] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = pos[i + a]!;
      if (c < min[a]!) min[a] = c;
      if (c > max[a]!) max[a] = c;
    }
  }
  return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
}

/**
 * Place element-local geometry (authored near the origin, f64) into one of
 * the four corpus cases. The local-frame cases mimic the wasm router: origin
 * = element AABB centre, positions re-based around it.
 */
export function placeWorldFrame(local: ArrayLike<number>, opts: PlaceOptions): PlacedMesh {
  const off = offsetVec(opts);
  const n = local.length;
  const out = new Float32Array(n);
  if (opts.frameCase === 'at-origin' || opts.frameCase === 'far-baked') {
    for (let i = 0; i < n; i++) out[i] = local[i]! + off[i % 3]!;
    return { positions: out };
  }
  const centre = aabbCentre(local);
  for (let i = 0; i < n; i++) out[i] = local[i]! - centre[i % 3]!;
  return {
    positions: out,
    origin: [centre[0] + off[0], centre[1] + off[1], centre[2] + off[2]],
  };
}

/**
 * Translate a placed mesh by a world-space delta, in ITS OWN frame:
 * an origin-carrying mesh moves only its origin (exactly how the wasm
 * local-frame pipeline expresses a moved element — positions untouched, the
 * #2529 trigger), a baked mesh moves its positions.
 */
export function translateWorld(placed: PlacedMesh, delta: readonly [number, number, number]): PlacedMesh {
  if (placed.origin) {
    return {
      positions: placed.positions,
      origin: [placed.origin[0] + delta[0], placed.origin[1] + delta[1], placed.origin[2] + delta[2]],
    };
  }
  const out = new Float32Array(placed.positions.length);
  for (let i = 0; i < out.length; i++) out[i] = placed.positions[i]! + delta[i % 3]!;
  return { positions: out };
}

export interface WorldAabb {
  min: [number, number, number];
  max: [number, number, number];
}

/** Ground-truth world AABB of a placed mesh — folds `origin`. */
export function worldAabb(placed: PlacedMesh): WorldAabb {
  const o = placed.origin ?? [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const p = placed.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0 as 0 | 1 | 2; a < 3; a++) {
      const c = p[i + a]! + o[a]!;
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  return { min, max };
}

/** Baked world-coordinate buffer (origin folded, f64 values of f32 inputs).
 *  What a consumer with no origin concept (e.g. the clash `Mesh`) ingests. */
export function bakedWorldPositions(placed: PlacedMesh): Float64Array {
  const o = placed.origin ?? [0, 0, 0];
  const out = new Float64Array(placed.positions.length);
  for (let i = 0; i < out.length; i++) out[i] = placed.positions[i]! + o[i % 3]!;
  return out;
}

/** Unit of least precision of an f32 at the given magnitude. */
export function ulp32(magnitude: number): number {
  const m = Math.abs(magnitude);
  if (m === 0) return 2 ** -149;
  const e = Math.floor(Math.log2(m));
  return 2 ** (Math.max(e, -126) - 23);
}

/**
 * The CORRECT f32 noise bound for a signed distance along plane normal `n`:
 * `sum_i |n_i| * ulp32(extent_i)`, with per-axis extents taken from the WORLD
 * coordinates of the given meshes. This is the section-cutter formulation
 * (PR #2622) generalised to an arbitrary normal: an axis orthogonal to `n`
 * contributes nothing, however far from the origin it puts the model —
 * which is exactly what `max |coordinate|` over all axes gets wrong.
 *
 * Tests use it to pick gaps that are provably ABOVE any legitimate tolerance
 * in every corpus case, so a genuine clearance misread as contact is a
 * defect, not a tolerance judgement call.
 */
export function normalProjectedNoiseBound(
  normal: readonly [number, number, number],
  meshes: readonly PlacedMesh[],
): number {
  const extent: [number, number, number] = [0, 0, 0];
  for (const placed of meshes) {
    const o = placed.origin ?? [0, 0, 0];
    const p = placed.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0 as 0 | 1 | 2; a < 3; a++) {
        const c = Math.abs(p[i + a]! + o[a]!);
        if (c > extent[a]) extent[a] = c;
      }
    }
  }
  return (
    Math.abs(normal[0]) * ulp32(extent[0]) +
    Math.abs(normal[1]) * ulp32(extent[1]) +
    Math.abs(normal[2]) * ulp32(extent[2])
  );
}

export interface ShapeTriangles {
  /** Element-local f64 positions, ready for {@link placeWorldFrame}. */
  positions: number[];
  indices: Uint32Array;
}

/**
 * An axis-aligned square (two triangles) with the given normal axis, lying at
 * `at` on that axis, spanning `[-size/2, size/2]` on the other two axes.
 */
export function quadTriangles(normalAxis: Axis, at: number, size = 1): ShapeTriangles {
  const h = size / 2;
  const n = AXIS_INDEX[normalAxis];
  const u = ((n + 1) % 3) as 0 | 1 | 2;
  const v = ((n + 2) % 3) as 0 | 1 | 2;
  const corners: [number, number][] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  const positions: number[] = [];
  for (const [cu, cv] of corners) {
    const p = [0, 0, 0];
    p[n] = at;
    p[u] = cu;
    p[v] = cv;
    positions.push(p[0]!, p[1]!, p[2]!);
  }
  return { positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

/** An axis-aligned box `[min..max]` as 12 triangles. */
export function boxTriangles(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): ShapeTriangles {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: number[][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { positions: v.flat(), indices: new Uint32Array(faces.flat()) };
}

export interface MeshDataOverrides {
  expressId?: number;
  ifcType?: string;
  modelIndex?: number;
}

/**
 * Wrap a placed shape as a `MeshData` (flat normals omitted as zeroes — none
 * of the world-frame consumers under test shade). Keeps the fixture's frame
 * convention type-checked against the real pipeline type.
 */
export function asMeshData(
  placed: PlacedMesh,
  indices: Uint32Array,
  overrides: MeshDataOverrides = {},
): MeshData {
  const mesh: MeshData = {
    expressId: overrides.expressId ?? 1,
    ifcType: overrides.ifcType ?? 'IfcWall',
    modelIndex: overrides.modelIndex ?? 0,
    positions: placed.positions,
    normals: new Float32Array(placed.positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
  if (placed.origin) mesh.origin = placed.origin;
  return mesh;
}
