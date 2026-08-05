/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  clipMeshByHalfSpace,
  clipMeshByConvexVolume,
  partitionMeshByConvexVolumes,
  planesFromOrientedBox,
  meshVolume,
  type ClipMeshInput,
  type ClipPlane,
  type ClipVec3,
} from './mesh-clip.js';

// ---------------------------------------------------------------------------
// Fixtures. Nothing here is axis-aligned-at-the-origin-with-unit-scale: every
// box is off-origin, rotated about Y by a non-right angle, and has three
// different non-unit extents. An identity-shaped fixture would let a clipper
// that silently returns its input pass most of this file.
// ---------------------------------------------------------------------------

/** 30 degrees — not a multiple of 90, so sin/cos are both non-zero and no
 *  local axis coincides with a world axis. */
const ROT = Math.PI / 6;

/** World offset applied AFTER rotation, so no fixture sits on the origin. */
const ANCHOR: ClipVec3 = [10, 2, -4];

function rotY(p: ClipVec3, angle: number): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [p[0] * cos - p[2] * sin, p[1], p[0] * sin + p[2] * cos];
}

/** Local point in the shared rotated frame -> world. */
function toWorld(p: ClipVec3): [number, number, number] {
  const r = rotY(p, ROT);
  return [r[0] + ANCHOR[0], r[1] + ANCHOR[1], r[2] + ANCHOR[2]];
}

/** A closed, outward-wound box: 8 shared vertices, 12 triangles. */
function makeBox(center: ClipVec3, size: ClipVec3, rotationY: number): ClipMeshInput {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  const local: ClipVec3[] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const positions: number[] = [];
  for (const p of local) {
    const r = rotY(p, rotationY);
    positions.push(r[0] + center[0], r[1] + center[1], r[2] + center[2]);
  }
  const indices = [
    0, 1, 2, 0, 2, 3, // -Y
    4, 7, 6, 4, 6, 5, // +Y
    3, 2, 6, 3, 6, 7, // +Z
    1, 0, 4, 1, 4, 5, // -Z
    2, 1, 5, 2, 5, 6, // +X
    0, 3, 7, 0, 7, 4, // -X
  ];
  return { positions, indices };
}

/**
 * A closed, outward-wound prism: an arbitrary (possibly NON-CONVEX) footprint
 * in the local X/Z plane, extruded `height` along Y, rotated about Y and
 * placed at `center`. `footprint` must run counter-clockwise seen from +Y and
 * be star-shaped about its first vertex (both true of the L below), so the
 * end caps can be fanned.
 */
function makePrism(
  center: ClipVec3,
  footprint: readonly (readonly [number, number])[],
  height: number,
  rotationY: number,
): ClipMeshInput {
  const n = footprint.length;
  const hy = height / 2;
  const positions: number[] = [];
  for (const y of [-hy, hy]) {
    for (const [x, z] of footprint) {
      const r = rotY([x, y, z], rotationY);
      positions.push(r[0] + center[0], r[1] + center[1], r[2] + center[2]);
    }
  }
  const indices: number[] = [];
  for (let k = 1; k + 1 < n; k += 1) {
    indices.push(n, n + k, n + k + 1); // +Y cap
    indices.push(0, k + 1, k); // -Y cap (reversed)
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  return { positions, indices };
}

/** An L-shaped footprint (one reflex corner), CCW seen from +Y, star-shaped
 *  about its first vertex. Area 4*1 + 1.5*2 = 7. */
const L_FOOTPRINT: (readonly [number, number])[] = [
  [0, 0], [0, 3], [1.5, 3], [1.5, 1], [4, 1], [4, 0],
];
const L_AREA = 7;
/** Area-weighted centroid of the two rectangles the L is made of. */
const L_CENTROID: [number, number] = [(4 * 2 + 3 * 0.75) / 7, (4 * 0.5 + 3 * 2) / 7];

/**
 * Signed volume measured about an arbitrary origin. For a CLOSED mesh this is
 * independent of where you measure from; for an open shell it is not. Used as
 * a watertightness probe that `meshVolume` alone cannot give.
 */
function volumeAbout(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }, o: ClipVec3): number {
  const shifted: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    shifted.push(mesh.positions[i] - o[0], mesh.positions[i + 1] - o[1], mesh.positions[i + 2] - o[2]);
  }
  return meshVolume({ positions: shifted, indices: mesh.indices });
}

function planeThrough(p1: ClipVec3, p2: ClipVec3, p3: ClipVec3, outsidePoint: ClipVec3): ClipPlane {
  const e1: ClipVec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const e2: ClipVec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
  let n: [number, number, number] = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  let offset = n[0] * p1[0] + n[1] * p1[1] + n[2] * p1[2];
  const side = n[0] * outsidePoint[0] + n[1] * outsidePoint[1] + n[2] * outsidePoint[2];
  if (side < offset) {
    n = [-n[0], -n[1], -n[2]];
    offset = -offset;
  }
  return { normal: n, offset };
}

// The reference solid used by most tests: a 6.0 x 3.0 x 0.4 m wall, rotated
// 30 degrees, centred well away from the origin.
const WALL_SIZE: ClipVec3 = [6, 3, 0.4];
const WALL_VOLUME = WALL_SIZE[0] * WALL_SIZE[1] * WALL_SIZE[2]; // 7.2
const WALL_CENTER = toWorld([3, 0, 0]);
const wall = (): ClipMeshInput => makeBox(WALL_CENTER, WALL_SIZE, ROT);

/** The wall with its -X face dropped: an open shell with four boundary edges.
 *  `meshVolume` still returns a number for it — a meaningless one — which is
 *  precisely why `capped` may never be asserted without looking at the mesh. */
const openWall = (): ClipMeshInput => {
  const closed = wall();
  return { positions: closed.positions, indices: (closed.indices as number[]).slice(0, -6) };
};

/** The same closed wall as an unindexed soup: every triangle carries its own
 *  three vertices. Bit-identical corners, so it is still a closed solid — the
 *  clipper welds by exact coordinate and must reach the same verdict. */
const soupWall = (): ClipMeshInput => {
  const closed = wall();
  const positions: number[] = [];
  const indices: number[] = [];
  for (const i of closed.indices as number[]) {
    indices.push(positions.length / 3);
    positions.push(closed.positions[i * 3], closed.positions[i * 3 + 1], closed.positions[i * 3 + 2]);
  }
  return { positions, indices };
};

describe('meshVolume', () => {
  it('measures an off-origin, rotated, non-unit box at its exact volume', () => {
    expect(meshVolume(wall())).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('is independent of the measurement origin for a closed mesh', () => {
    expect(volumeAbout(wall(), [-1234, 567, 89])).toBeCloseTo(WALL_VOLUME, 8);
  });

  it('is zero for an empty mesh', () => {
    expect(meshVolume({ positions: [], indices: [] })).toBe(0);
  });
});

describe('clipMeshByHalfSpace - triangles entirely on one side', () => {
  it('keeps everything inside when the plane misses the mesh on the outside', () => {
    // Plane far along +X-ish, whole wall is on the `<= offset` side.
    const plane: ClipPlane = { normal: [1, 2, -3], offset: 1000 };
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(outside.indices.length).toBe(0);
    expect(inside.capped).toBe(true);
  });

  it('keeps everything outside when the plane misses the mesh on the inside', () => {
    const plane: ClipPlane = { normal: [1, 2, -3], offset: -1000 };
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    expect(inside.indices.length).toBe(0);
    expect(meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 10);
  });
});

describe('clipMeshByHalfSpace - straddling', () => {
  // Slice a corner tetrahedron off the rotated wall with an oblique plane
  // through three points 2.0 / 1.0 / 0.1 m back from one corner along the
  // wall's own local axes -> tetra volume = 2*1*0.1/6.
  const corner = toWorld([3 + 3, 1.5, 0.2]);
  const p1 = toWorld([3 + 1, 1.5, 0.2]);
  const p2 = toWorld([3 + 3, 0.5, 0.2]);
  const p3 = toWorld([3 + 3, 1.5, 0.1]);
  const TETRA = (2 * 1 * 0.1) / 6;
  const plane = planeThrough(p1, p2, p3, corner);

  it('cuts the analytically-known corner volume off', () => {
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    expect(meshVolume(outside)).toBeCloseTo(TETRA, 10);
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME - TETRA, 10);
  });

  it('conserves total volume across the cut', () => {
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    expect(meshVolume(inside) + meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('produces two closed solids (volume independent of measurement origin)', () => {
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
    expect(volumeAbout(inside, [-500, 300, 71])).toBeCloseTo(meshVolume(inside), 8);
    expect(volumeAbout(outside, [-500, 300, 71])).toBeCloseTo(meshVolume(outside), 8);
  });

  it('keeps outward winding on both pieces', () => {
    // Both pieces are convex, so every triangle normal must point away from
    // the piece's own centroid. A flipped cap or a reversed clipped polygon
    // shows up here (and renders black or inside-out in the viewer).
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane);
    for (const piece of [inside, outside]) {
      expect(piece.indices.length).toBeGreaterThan(0);
      const c = centroid(piece);
      for (let t = 0; t < piece.indices.length; t += 3) {
        expect(outwardness(piece, t, c)).toBeGreaterThan(0);
      }
    }
  });

  it('cuts the same way regardless of which side the plane normal names', () => {
    const flipped: ClipPlane = {
      normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
      offset: -plane.offset,
    };
    const a = clipMeshByHalfSpace(wall(), plane);
    const b = clipMeshByHalfSpace(wall(), flipped);
    expect(meshVolume(b.inside)).toBeCloseTo(meshVolume(a.outside), 10);
    expect(meshVolume(b.outside)).toBeCloseTo(meshVolume(a.inside), 10);
  });
});

function centroid(mesh: { positions: ArrayLike<number> }): ClipVec3 {
  let x = 0, y = 0, z = 0;
  const n = mesh.positions.length / 3;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    x += mesh.positions[i];
    y += mesh.positions[i + 1];
    z += mesh.positions[i + 2];
  }
  return [x / n, y / n, z / n];
}

/** dot(triangle normal, triangle centroid - mesh centroid). */
function outwardness(
  mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> },
  t: number,
  c: ClipVec3,
): number {
  const p = mesh.positions;
  const a = mesh.indices[t] * 3, b = mesh.indices[t + 1] * 3, d = mesh.indices[t + 2] * 3;
  const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
  const e2 = [p[d] - p[a], p[d + 1] - p[a + 1], p[d + 2] - p[a + 2]];
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const m = [
    (p[a] + p[b] + p[d]) / 3 - c[0],
    (p[a + 1] + p[b + 1] + p[d + 1]) / 3 - c[1],
    (p[a + 2] + p[b + 2] + p[d + 2]) / 3 - c[2],
  ];
  return n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
}

describe('clipMeshByHalfSpace - exact-boundary contact', () => {
  // The wall's own +Y face, exactly on the plane.
  const topY = ANCHOR[1] + WALL_SIZE[1] / 2;

  it('assigns a coplanar face to the piece its solid is on (normal along +n)', () => {
    const { inside, outside } = clipMeshByHalfSpace(wall(), { normal: [0, 1, 0], offset: topY });
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(outside.indices.length).toBe(0);
  });

  it('assigns a coplanar face to the piece its solid is on (normal along -n)', () => {
    const { inside, outside } = clipMeshByHalfSpace(wall(), { normal: [0, -1, 0], offset: -topY });
    expect(inside.indices.length).toBe(0);
    expect(meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('handles a plane touching the mesh along a single edge', () => {
    // Support direction (0, 1, 1) in the wall's own frame picks out the whole
    // top/+Z edge. Everything must stay on the inside as ONE closed solid:
    // treating those on-plane vertices as outside would carve zero-area
    // slivers off and leave both pieces open.
    const dir = rotY([0, 1, 1], ROT);
    const edgeEnd = toWorld([3 + 3, 1.5, 0.2]);
    const off = dir[0] * edgeEnd[0] + dir[1] * edgeEnd[1] + dir[2] * edgeEnd[2];
    const { inside, outside } = clipMeshByHalfSpace(wall(), { normal: dir, offset: off });
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(inside.capped).toBe(true);
    expect(inside.indices.length).toBe(36);
    expect(outside.indices.length).toBe(0);
  });

  it('handles a plane touching the mesh at a single vertex', () => {
    // The wall's local (+hx, +hy, +hz) corner is the unique support point
    // along the rotated local (1, 1, 1) direction.
    const cornerLocal: ClipVec3 = [3 + 3, 1.5, 0.2];
    const cornerWorld = toWorld(cornerLocal);
    const dir = rotY([1, 1, 1], ROT);
    const off = dir[0] * cornerWorld[0] + dir[1] * cornerWorld[1] + dir[2] * cornerWorld[2];

    const touchInside = clipMeshByHalfSpace(wall(), { normal: dir, offset: off });
    expect(meshVolume(touchInside.inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(meshVolume(touchInside.outside)).toBeCloseTo(0, 10);

    const touchOutside = clipMeshByHalfSpace(wall(), {
      normal: [-dir[0], -dir[1], -dir[2]],
      offset: -off,
    });
    expect(meshVolume(touchOutside.inside)).toBeCloseTo(0, 10);
    expect(meshVolume(touchOutside.outside)).toBeCloseTo(WALL_VOLUME, 10);
  });
});

describe('clipMeshByHalfSpace - non-convex cross-section', () => {
  // An L-shaped prism: the cut cross-section has a reflex corner, so the cap
  // cannot be fanned and the ear-clip has to respect the loop's own
  // orientation. A convex-only fixture would let a wrong-way triangulation
  // through, because fanning a convex loop happens to be correct.
  const PRISM_HEIGHT = 2.5;
  const PRISM_CENTER = toWorld([1, 0.4, 2]);
  const prism = (): ClipMeshInput => makePrism(PRISM_CENTER, L_FOOTPRINT, PRISM_HEIGHT, ROT);
  const PRISM_VOLUME = L_AREA * PRISM_HEIGHT;

  // A plane tilted in both footprint directions, crossing every side wall.
  // For a plane over a region, the volume beneath it is area x its height at
  // the region's CENTROID, which makes the split analytically exact.
  const slopeX = 0.15;
  const slopeZ = -0.1;
  const y0 = 0.3;
  const nLocal: ClipVec3 = [-slopeX, 1, -slopeZ];
  const offsetLocal = y0 - slopeX * L_CENTROID[0] - slopeZ * L_CENTROID[1];
  const nWorld = rotY(nLocal, ROT);
  const planeWorld: ClipPlane = {
    normal: nWorld,
    offset:
      offsetLocal +
      nWorld[0] * PRISM_CENTER[0] + nWorld[1] * PRISM_CENTER[1] + nWorld[2] * PRISM_CENTER[2],
  };

  it('measures the L prism itself correctly', () => {
    expect(meshVolume(prism())).toBeCloseTo(PRISM_VOLUME, 10);
  });

  it('splits it at the analytically known height', () => {
    const { inside, outside } = clipMeshByHalfSpace(prism(), planeWorld);
    expect(meshVolume(inside)).toBeCloseTo(L_AREA * (y0 + PRISM_HEIGHT / 2), 9);
    expect(meshVolume(outside)).toBeCloseTo(L_AREA * (PRISM_HEIGHT / 2 - y0), 9);
  });

  it('caps the reflex cross-section into closed solids', () => {
    const { inside, outside } = clipMeshByHalfSpace(prism(), planeWorld);
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
    expect(volumeAbout(inside, [-210, 340, -55])).toBeCloseTo(meshVolume(inside), 8);
    expect(volumeAbout(outside, [-210, 340, -55])).toBeCloseTo(meshVolume(outside), 8);
  });

  it('conserves volume', () => {
    const { inside, outside } = clipMeshByHalfSpace(prism(), planeWorld);
    expect(meshVolume(inside) + meshVolume(outside)).toBeCloseTo(PRISM_VOLUME, 9);
  });

  it('triangulates the reflex cap without inverting any triangle', () => {
    // Volume alone cannot see this: fanning or clipping the wrong ear still
    // sums to the right signed area, it just emits overlapping triangles,
    // some of them back-to-front. Those render black. Every triangle lying in
    // the cut plane must face the same way.
    const { inside, outside } = clipMeshByHalfSpace(prism(), planeWorld);
    // The inside piece is the `dot(n, p) <= offset` half, so its cap faces
    // +n; the outside piece's faces -n.
    for (const [piece, expected] of [[inside, 1], [outside, -1]] as const) {
      const dots = capTriangleNormals(piece, planeWorld);
      expect(dots.length).toBeGreaterThanOrEqual(L_FOOTPRINT.length - 2);
      for (const dot of dots) expect(Math.sign(dot)).toBe(expected);
    }
  });
});

/** `dot(triangle normal, plane normal)` for every triangle of `mesh` whose
 *  three vertices all lie on `plane`. */
function capTriangleNormals(
  mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> },
  plane: ClipPlane,
): number[] {
  const len = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  const n = [plane.normal[0] / len, plane.normal[1] / len, plane.normal[2] / len];
  const d = plane.offset / len;
  const p = mesh.positions;
  const on = (i: number): boolean =>
    Math.abs(n[0] * p[i * 3] + n[1] * p[i * 3 + 1] + n[2] * p[i * 3 + 2] - d) < 1e-9;
  const out: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t], ib = mesh.indices[t + 1], ic = mesh.indices[t + 2];
    if (!on(ia) || !on(ib) || !on(ic)) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const cr = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    out.push(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]);
  }
  return out;
}

describe('clipMeshByHalfSpace - degenerate input', () => {
  it('returns two empty meshes for an empty mesh', () => {
    const { inside, outside } = clipMeshByHalfSpace({ positions: [], indices: [] }, {
      normal: [1, 2, -3],
      offset: 5,
    });
    expect(inside.indices.length).toBe(0);
    expect(outside.indices.length).toBe(0);
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
  });

  it('ignores zero-area triangles without disturbing the volume', () => {
    const base = wall();
    const degenerate: ClipMeshInput = {
      positions: base.positions,
      // A repeated-vertex triangle and a collinear one (two coincident
      // corners of the same edge) on top of the real box.
      indices: [...(base.indices as number[]), 0, 0, 1, 2, 2, 2],
    };
    const plane: ClipPlane = { normal: [1, 2, -3], offset: 1000 };
    const cut = clipMeshByHalfSpace(degenerate, plane);
    const clean = clipMeshByHalfSpace(base, plane);
    expect(meshVolume(cut.inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(cut.outside.indices.length).toBe(0);
    // Dropped, not merely harmless: the zero-area triangles must not reach
    // the output, or every downstream consumer inherits them.
    expect(cut.inside.indices.length).toBe(clean.inside.indices.length);
  });

  it('leaves the cut open, and says so, when capping is turned off', () => {
    const plane = planeThrough(
      toWorld([3 + 1, 1.5, 0.2]),
      toWorld([3 + 3, 0.5, 0.2]),
      toWorld([3 + 3, 1.5, 0.1]),
      toWorld([3 + 3, 1.5, 0.2]),
    );
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane, { cap: false });
    expect(inside.capped).toBe(false);
    expect(outside.capped).toBe(false);
    // Open shells. The pair still sums to the source volume (the two shells
    // together are just a retriangulation of the original surface), but
    // NEITHER piece is a solid on its own — which the origin-dependence of
    // its signed volume proves, and which is exactly why the flag has to be
    // false before anyone quotes a per-zone quantity.
    expect(volumeAbout(inside, [-500, 300, 71])).not.toBeCloseTo(meshVolume(inside), 6);
    expect(volumeAbout(outside, [-500, 300, 71])).not.toBeCloseTo(meshVolume(outside), 6);
  });

  it('rejects a zero-length plane normal', () => {
    expect(() => clipMeshByHalfSpace(wall(), { normal: [0, 0, 0], offset: 1 })).toThrow(
      /non-zero/,
    );
  });

  it('reports capped: false when the cut cannot be closed', () => {
    // A lone triangle is not a solid: its cut edge has nowhere to chain to.
    const lone: ClipMeshInput = {
      positions: [0, 0, 0, 4, 0, 0, 0, 4, 0],
      indices: [0, 1, 2],
    };
    const { inside, outside } = clipMeshByHalfSpace(lone, { normal: [1, 0, 0], offset: 2 });
    expect(inside.capped).toBe(false);
    expect(outside.capped).toBe(false);
    expect(inside.indices.length).toBeGreaterThan(0);
    expect(outside.indices.length).toBeGreaterThan(0);
  });
});

describe('clipMeshByHalfSpace - cap tolerance follows options.epsilon', () => {
  /**
   * A prism whose MIDDLE ring of vertices misses the cut plane by `jitter` —
   * a sloppy mesh of exactly the kind `epsilon` exists to tolerate. Rings run
   * bottom, middle, top along local Y; the middle ring alternates the jitter
   * in sign so the ring is genuinely non-planar rather than merely offset.
   */
  function jitteredPrism(jitter: number): ClipMeshInput {
    const foot: [number, number][] = [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ];
    const n = foot.length;
    const positions: number[] = [];
    const ys = [-2, 0, 2];
    for (let r = 0; r < ys.length; r += 1) {
      for (let i = 0; i < n; i += 1) {
        const dy = r === 1 ? (i % 2 === 0 ? jitter : -jitter) : 0;
        const p = rotY([foot[i][0], ys[r] + dy, foot[i][1]], ROT);
        positions.push(p[0] + ANCHOR[0], p[1] + ANCHOR[1], p[2] + ANCHOR[2]);
      }
    }
    const indices: number[] = [];
    for (let r = 0; r + 1 < ys.length; r += 1) {
      const lo = r * n;
      const hi = (r + 1) * n;
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        indices.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
      }
    }
    const top = (ys.length - 1) * n;
    for (let k = 1; k + 1 < n; k += 1) {
      indices.push(top, top + k, top + k + 1);
      indices.push(0, k + 1, k);
    }
    return { positions, indices };
  }

  /** The plane the middle ring is supposed to lie on: local y = 0. */
  const midPlane = (): ClipPlane => {
    const nrm = rotY([0, 1, 0], ROT);
    return { normal: nrm, offset: nrm[0] * ANCHOR[0] + nrm[1] * ANCHOR[1] + nrm[2] * ANCHOR[2] };
  };

  const JITTER = 4e-7;

  it('is a closed solid before it is cut', () => {
    // The fixture has to be a solid, or "capped: false" below would be right
    // for the wrong reason.
    const seeded = clipMeshByConvexVolume(jitteredPrism(JITTER), []).inside;
    expect(seeded.capped).toBe(true);
  });

  it('caps a cut whose boundary sits within the epsilon the caller asked for', () => {
    // The classification pass treats the middle ring as ON the plane (|s| <=
    // epsilon), and the crossing points snap onto those very vertices. If the
    // cap membership test uses a different, tighter tolerance, the same
    // vertices come back OFF the plane, the boundary loop is discarded as
    // "not on the cut plane", and the caller gets two open shells whose
    // volumes are meaningless — from a mesh they explicitly declared sloppy.
    const eps = 1e-6;
    const { inside, outside } = clipMeshByHalfSpace(jitteredPrism(JITTER), midPlane(), {
      epsilon: eps,
    });
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
    expect(meshVolume(inside)).toBeCloseTo(8, 5);
    expect(meshVolume(outside)).toBeCloseTo(8, 5);
    expect(volumeAbout(inside, [-500, 300, 71])).toBeCloseTo(meshVolume(inside), 5);
  });

  /**
   * Two open tubes with a `gap`-wide slot between them, straddling the same
   * plane: the plane cuts nothing, and each piece keeps one boundary ring that
   * lies NEAR the plane without being on it. Whether those rings may be capped
   * is exactly the tolerance question, so this fixture answers it in both
   * directions — a tolerance too tight leaves a solid open, one too loose
   * fabricates a lid (and with it a volume) across a hole the caller never
   * said was a cut.
   */
  function slottedTubes(gap: number): ClipMeshInput {
    const foot: [number, number][] = [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ];
    const n = foot.length;
    const positions: number[] = [];
    for (const y of [-2, -gap, gap, 2]) {
      for (const [x, z] of foot) {
        const p = rotY([x, y, z], ROT);
        positions.push(p[0] + ANCHOR[0], p[1] + ANCHOR[1], p[2] + ANCHOR[2]);
      }
    }
    const indices: number[] = [];
    for (const lo of [0, 2 * n]) {
      const hi = lo + n;
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        indices.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
      }
    }
    for (let k = 1; k + 1 < n; k += 1) {
      indices.push(0, k + 1, k); // -Y cap on the lower tube
      indices.push(3 * n, 3 * n + k, 3 * n + k + 1); // +Y cap on the upper tube
    }
    return { positions, indices };
  }

  it('still closes an ordinary cut at epsilon zero', () => {
    // The floor under the tolerance. Crossing points are interpolated, so they
    // land on the plane only to within rounding at the scale of the
    // coordinates; a tolerance taken raw from `epsilon: 0` would reject the
    // clipper's own output and report an open shell for a clean cut.
    const plane = planeThrough(
      toWorld([3 + 1, 1.5, 0.2]),
      toWorld([3 + 3, 0.5, 0.2]),
      toWorld([3 + 3, 1.5, 0.1]),
      toWorld([3 + 3, 1.5, 0.2]),
    );
    const { inside, outside } = clipMeshByHalfSpace(wall(), plane, { epsilon: 0 });
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
    expect(meshVolume(inside) + meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 9);
  });

  it('will not cap a hole that merely lies near the plane', () => {
    // The other half of the contract, and the reason the tolerance is the
    // caller's to set rather than something to widen for safety: at the
    // default epsilon these rings are off the plane, so neither piece is a
    // solid and both must say so.
    const { inside, outside } = clipMeshByHalfSpace(slottedTubes(1e-4), midPlane());
    expect(inside.capped).toBe(false);
    expect(outside.capped).toBe(false);
  });

  it('caps the same hole once the caller declares that much slop', () => {
    // Same mesh, same plane, epsilon raised past the gap: now the rings are
    // on the plane by the caller's own definition, so they are cut boundaries
    // and each piece closes into a solid — which its origin-independent
    // signed volume confirms.
    const { inside, outside } = clipMeshByHalfSpace(slottedTubes(1e-4), midPlane(), {
      epsilon: 1e-2,
    });
    expect(inside.capped).toBe(true);
    expect(outside.capped).toBe(true);
    expect(volumeAbout(inside, [-500, 300, 71])).toBeCloseTo(meshVolume(inside), 6);
    // 4 m^2 of cross-section over the two 2 m tubes, less the 1e-4 slot each
    // lid is set back by — the caps close on the rings themselves, not on the
    // plane, so the slot is missing from the total rather than shared out.
    expect(meshVolume(inside) + meshVolume(outside)).toBeCloseTo(16 - 8e-4, 9);
  });
});

describe('planesFromOrientedBox', () => {
  it('describes the box it was built from', () => {
    const center = toWorld([1, 0.5, -2]);
    const planes = planesFromOrientedBox({ center, size: [5, 8, 4], rotationY: ROT });
    expect(planes).toHaveLength(6);
    const inside = (p: ClipVec3): boolean =>
      planes.every((pl) => pl.normal[0] * p[0] + pl.normal[1] * p[1] + pl.normal[2] * p[2] <= pl.offset + 1e-9);
    // Centre is in; a point just past each local face is out.
    expect(inside(center)).toBe(true);
    const local = (dx: number, dy: number, dz: number): ClipVec3 => {
      const r = rotY([dx, dy, dz], ROT);
      return [center[0] + r[0], center[1] + r[1], center[2] + r[2]];
    };
    expect(inside(local(2.49, 0, 0))).toBe(true);
    expect(inside(local(2.51, 0, 0))).toBe(false);
    expect(inside(local(0, 3.99, 0))).toBe(true);
    expect(inside(local(0, 4.01, 0))).toBe(false);
    expect(inside(local(0, 0, 1.99))).toBe(true);
    expect(inside(local(0, 0, 2.01))).toBe(false);
  });
});

describe('clipMeshByConvexVolume', () => {
  it('returns the whole mesh when the volume has no boundaries', () => {
    const { inside, outside } = clipMeshByConvexVolume(wall(), []);
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(outside.indices.length).toBe(0);
  });

  it('derives capped from the mesh when the volume has no boundaries', () => {
    // Zero planes never enter the clip loop, so nothing downstream re-derives
    // `capped`: whatever the result is seeded with is what the caller gets.
    // An open shell must not come back claiming to be a solid — `meshVolume`
    // is documented as meaningless until the flag has been checked.
    const open = clipMeshByConvexVolume(openWall(), []).inside;
    expect(open.capped).toBe(false);
    expect(volumeAbout(open, [-500, 300, 71])).not.toBeCloseTo(meshVolume(open), 6);

    // ...and a genuinely closed mesh must still report true, indexed or as
    // a welded-by-coordinate soup.
    expect(clipMeshByConvexVolume(wall(), []).inside.capped).toBe(true);
    expect(clipMeshByConvexVolume(soupWall(), []).inside.capped).toBe(true);
    expect(clipMeshByConvexVolume({ positions: [], indices: [] }, []).inside.capped).toBe(true);
  });

  it('owns the buffers it hands back when the volume has no boundaries', () => {
    // Every other path builds fresh arrays (MeshBuilder.build / mergeMeshes),
    // so a caller may edit a returned piece in place. On this path the seed
    // conversions are no-ops for input that is already typed, so the result
    // used to alias the CALLER's arrays: a later edit to either side silently
    // rewrote the other, and the ownership contract held or not depending on
    // which array type the caller happened to pass.
    const src = wall();
    const positions = Float64Array.from(src.positions);
    const indices = Uint32Array.from(src.indices);
    const { inside } = clipMeshByConvexVolume({ positions, indices }, []);
    expect(inside.positions).not.toBe(positions);
    expect(inside.indices).not.toBe(indices);

    positions[0] += 100;
    indices[0] = indices[1];
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('returns the whole mesh when the volume contains everything', () => {
    const planes = planesFromOrientedBox({ center: toWorld([3, 0, 0]), size: [200, 200, 200], rotationY: ROT });
    const { inside, outside } = clipMeshByConvexVolume(wall(), planes);
    expect(meshVolume(inside)).toBeCloseTo(WALL_VOLUME, 10);
    expect(meshVolume(outside)).toBeCloseTo(0, 10);
  });

  it('returns nothing when the volume contains nothing', () => {
    const planes = planesFromOrientedBox({ center: [500, 500, 500], size: [5, 8, 4], rotationY: ROT });
    const { inside, outside } = clipMeshByConvexVolume(wall(), planes);
    expect(inside.indices.length).toBe(0);
    expect(meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('conserves volume when the volume clips several faces at once', () => {
    // A zone whose box crosses the wall on three sides at a different
    // rotation from the wall's own, so no clip plane is parallel to a wall
    // face and every plane really cuts.
    const planes = planesFromOrientedBox({
      center: toWorld([4.2, 0.7, 0.05]),
      size: [3.3, 2.1, 1.7],
      rotationY: ROT + 0.37,
    });
    const { inside, outside } = clipMeshByConvexVolume(wall(), planes);
    expect(meshVolume(inside)).toBeGreaterThan(0.05);
    expect(meshVolume(inside)).toBeLessThan(WALL_VOLUME);
    expect(meshVolume(inside) + meshVolume(outside)).toBeCloseTo(WALL_VOLUME, 9);
    expect(volumeAbout(inside, [-400, 220, 66])).toBeCloseTo(meshVolume(inside), 8);
  });
});

describe('partitionMeshByConvexVolumes', () => {
  // The reporter's case from issue #1810: one wall crossing the boundary of
  // two adjacent takt areas becomes two pieces with their own quantities.
  // Zones and wall share the 30-degree rotation, so the split is exact and
  // analytically known: 2.0 m of the 6.0 m wall in zone A, 4.0 m in zone B.
  const zoneA = planesFromOrientedBox({ center: toWorld([0, 0, 0]), size: [4, 8, 6], rotationY: ROT });
  const zoneB = planesFromOrientedBox({ center: toWorld([5, 0, 0]), size: [6, 8, 6], rotationY: ROT });
  const faraway = planesFromOrientedBox({ center: [900, 0, 900], size: [4, 4, 4], rotationY: ROT });

  it('splits a boundary-crossing wall into the analytically correct pieces', () => {
    const { parts, remainder } = partitionMeshByConvexVolumes(wall(), [zoneA, zoneB]);
    expect(parts).toHaveLength(2);
    expect(meshVolume(parts[0])).toBeCloseTo(2 * 3 * 0.4, 9);
    expect(meshVolume(parts[1])).toBeCloseTo(4 * 3 * 0.4, 9);
    expect(meshVolume(remainder)).toBeCloseTo(0, 9);
  });

  it('conserves the wall volume across parts and remainder', () => {
    const { parts, remainder } = partitionMeshByConvexVolumes(wall(), [zoneA, zoneB]);
    const total = parts.reduce((s, p) => s + meshVolume(p), 0) + meshVolume(remainder);
    expect(total).toBeCloseTo(WALL_VOLUME, 9);
  });

  it('emits every piece as its own closed solid', () => {
    const { parts } = partitionMeshByConvexVolumes(wall(), [zoneA, zoneB]);
    for (const part of parts) {
      expect(part.capped).toBe(true);
      expect(volumeAbout(part, [-321, 654, -98])).toBeCloseTo(meshVolume(part), 8);
    }
  });

  it('keeps an index-aligned empty piece for a volume the mesh never reaches', () => {
    const { parts, remainder } = partitionMeshByConvexVolumes(wall(), [zoneA, faraway, zoneB]);
    expect(parts).toHaveLength(3);
    expect(meshVolume(parts[0])).toBeCloseTo(2 * 3 * 0.4, 9);
    expect(parts[1].indices.length).toBe(0);
    expect(meshVolume(parts[2])).toBeCloseTo(4 * 3 * 0.4, 9);
    expect(meshVolume(remainder)).toBeCloseTo(0, 9);
  });

  it('gives overlapping volumes to the earlier zone rather than double-counting', () => {
    const wide = planesFromOrientedBox({ center: toWorld([3, 0, 0]), size: [20, 20, 20], rotationY: ROT });
    const { parts, remainder } = partitionMeshByConvexVolumes(wall(), [zoneA, wide]);
    expect(meshVolume(parts[0])).toBeCloseTo(2 * 3 * 0.4, 9);
    expect(meshVolume(parts[1])).toBeCloseTo(4 * 3 * 0.4, 9);
    expect(meshVolume(remainder)).toBeCloseTo(0, 9);
  });

  it('derives the remainder capped from the mesh when there are no volumes', () => {
    // No volumes means no clip runs, so the remainder's flag is the seed. An
    // open shell handed straight back must say so.
    const open = partitionMeshByConvexVolumes(openWall(), []).remainder;
    expect(open.capped).toBe(false);
    expect(volumeAbout(open, [-500, 300, 71])).not.toBeCloseTo(meshVolume(open), 6);

    const closed = partitionMeshByConvexVolumes(wall(), []);
    expect(closed.parts).toHaveLength(0);
    expect(closed.remainder.capped).toBe(true);
    expect(meshVolume(closed.remainder)).toBeCloseTo(WALL_VOLUME, 10);
    expect(partitionMeshByConvexVolumes(soupWall(), []).remainder.capped).toBe(true);
  });

  it('owns the remainder buffers when there are no volumes', () => {
    // Same aliasing on the sibling early return: with no volume to clip
    // against, the seed IS the remainder, and it must be a copy of the
    // caller's mesh rather than the mesh itself.
    const src = wall();
    const positions = Float64Array.from(src.positions);
    const indices = Uint32Array.from(src.indices);
    const { remainder } = partitionMeshByConvexVolumes({ positions, indices }, []);
    expect(remainder.positions).not.toBe(positions);
    expect(remainder.indices).not.toBe(indices);

    positions[0] += 100;
    indices[0] = indices[1];
    expect(meshVolume(remainder)).toBeCloseTo(WALL_VOLUME, 10);
  });

  it('leaves the part outside every zone in the remainder', () => {
    const { parts, remainder } = partitionMeshByConvexVolumes(wall(), [zoneA]);
    expect(meshVolume(parts[0])).toBeCloseTo(2 * 3 * 0.4, 9);
    expect(meshVolume(remainder)).toBeCloseTo(WALL_VOLUME - 2 * 3 * 0.4, 9);
    expect(remainder.capped).toBe(true);
  });
});
