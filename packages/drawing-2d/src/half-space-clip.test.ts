/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU half-space clipping for the to-scale 3D-view PDF (issue #2042).
 *
 * Defect class: the `MeshData.origin` double-fold. `positions` are LOCAL
 * (`world = origin + positions`), the section plane is WORLD, so a clip that
 * forgets the conversion cuts an element at the wrong place, and one that
 * bakes world coordinates into `positions` while leaving `origin` set
 * translates the element by `origin` twice downstream. Both produce
 * plausible-looking geometry in the wrong place.
 *
 * The load-bearing assertion is the twin comparison: a mesh with
 * `origin = [100, 0, 0]` and local positions must clip to exactly the same
 * WORLD result as a baked-positions twin of the same element — while its own
 * `positions` stay local and its `origin` survives untouched.
 *
 * The rim length is pinned numerically. NOTE: the plan document said a unit
 * cube cut at x = 0.25 yields a rim loop of total length 3.0 m; that is
 * wrong. The cross-section is a 1 x 1 m square, so the closed rim loop is
 * 4 x 1 = 4.0 m. The test pins the geometrically correct 4.0.
 */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { clipMeshToHalfSpace, clipMeshesToHalfSpace, type WorldSegment } from './half-space-clip.js';
import { vec3 } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Axis-aligned box between WORLD corners `min`/`max`, stored the way
 * `MeshData` stores geometry: positions in the element's LOCAL frame with an
 * optional per-element `origin` (world = origin + local).
 */
function boxGeometry(
  min: [number, number, number],
  max: [number, number, number],
  origin: [number, number, number],
): { positions: number[]; indices: number[] } {
  const [x0, y0, z0] = [min[0] - origin[0], min[1] - origin[1], min[2] - origin[2]];
  const [x1, y1, z1] = [max[0] - origin[0], max[1] - origin[1], max[2] - origin[2]];
  return {
    positions: [
      x0, y0, z0, // 0
      x1, y0, z0, // 1
      x1, y1, z0, // 2
      x0, y1, z0, // 3
      x0, y0, z1, // 4
      x1, y0, z1, // 5
      x1, y1, z1, // 6
      x0, y1, z1, // 7
    ],
    indices: [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ],
  };
}

function boxMesh(
  min: [number, number, number],
  max: [number, number, number],
  origin?: [number, number, number],
): MeshData {
  const o = origin ?? [0, 0, 0];
  const { positions, indices } = boxGeometry(min, max, o);
  const mesh: MeshData = {
    expressId: 42,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    color: [1, 1, 1, 1],
  };
  if (origin) mesh.origin = origin;
  return mesh;
}

/** Two disjoint boxes in ONE mesh, so one is fully kept and one fully dropped. */
function twoBoxMesh(): MeshData {
  const a = boxGeometry([0, 0, 0], [1, 1, 1], [0, 0, 0]);
  const b = boxGeometry([3, 0, 0], [4, 1, 1], [0, 0, 0]);
  const positions = [...a.positions, ...b.positions];
  const offset = a.positions.length / 3;
  const indices = [...a.indices, ...b.indices.map((i) => i + offset)];
  return {
    expressId: 7,
    ifcType: 'IfcSlab',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    color: [1, 1, 1, 1],
  };
}

/** World-space vertices of a mesh (folds `origin`), as [x,y,z] triples. */
function worldVertices(mesh: MeshData): Array<[number, number, number]> {
  const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    out.push([
      mesh.positions[i * 3] + ox,
      mesh.positions[i * 3 + 1] + oy,
      mesh.positions[i * 3 + 2] + oz,
    ]);
  }
  return out;
}

const key = (p: readonly number[]) => p.map((v) => v.toFixed(9)).join(',');

function sortedVertexKeys(mesh: MeshData): string[] {
  return worldVertices(mesh).map(key).sort();
}

function totalLength(segments: readonly WorldSegment[]): number {
  return segments.reduce(
    (sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z),
    0,
  );
}

/**
 * Assert the rim segments form ONE closed loop: every endpoint is shared by
 * exactly two segments, and the whole set is a single connected component.
 * A half-space clip that leaks (misses one cut triangle) shows up here as a
 * degree-1 node long before it shows up as a wrong total length.
 */
function assertSingleClosedLoop(segments: readonly WorldSegment[]): void {
  const degree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const s of segments) {
    const a = key([s.start.x, s.start.y, s.start.z]);
    const b = key([s.end.x, s.end.y, s.end.z]);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  expect(degree.size).toBeGreaterThan(2);
  for (const [node, d] of degree) {
    expect(`${node}: degree ${d}`).toBe(`${node}: degree 2`);
  }
  // Single connected component.
  const start = [...degree.keys()][0];
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  expect(seen.size).toBe(degree.size);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('clipMeshToHalfSpace — unit cube cut at x = 0.25', () => {
  const cube = boxMesh([0, 0, 0], [1, 1, 1]);
  const result = clipMeshToHalfSpace(cube, vec3(1, 0, 0), 0.25);

  it('keeps only geometry in the kept half-space', () => {
    expect(result.mesh).not.toBeNull();
    const vertices = worldVertices(result.mesh as MeshData);
    expect(vertices.length).toBeGreaterThan(0);
    for (const [x] of vertices) {
      expect(x).toBeLessThanOrEqual(0.25 + 1e-9);
    }
    // ...and it kept the whole 0.25 m slice, not a sliver of it.
    expect(Math.min(...vertices.map(([x]) => x))).toBeCloseTo(0, 9);
    expect(Math.max(...vertices.map(([x]) => x))).toBeCloseTo(0.25, 6);
  });

  it('emits a rim that is one closed loop of total length exactly 4.0 m', () => {
    // A unit cube's cross-section at x = 0.25 is a 1 x 1 m square: perimeter
    // 4 x 1 m. (The plan document's "3.0" was arithmetically wrong.)
    expect(totalLength(result.rimSegments)).toBeCloseTo(4, 9);
    assertSingleClosedLoop(result.rimSegments);
  });

  it('places every rim vertex exactly on the cut plane', () => {
    expect(result.rimSegments.length).toBeGreaterThan(0);
    for (const s of result.rimSegments) {
      expect(s.start.x).toBeCloseTo(0.25, 6);
      expect(s.end.x).toBeCloseTo(0.25, 6);
    }
  });

  it('carries the source element metadata onto the rim', () => {
    for (const s of result.rimSegments) {
      expect(s.entityId).toBe(42);
      expect(s.ifcType).toBe('IfcWall');
      expect(s.modelIndex).toBe(0);
    }
  });
});

describe('clipMeshToHalfSpace — the MeshData.origin double-fold', () => {
  const NORMAL = vec3(1, 0, 0);
  const OFFSET = 100.25;

  const localFrame = boxMesh([100, 0, 0], [101, 1, 1], [100, 0, 0]);
  const bakedTwin = boxMesh([100, 0, 0], [101, 1, 1]);

  it('clips a local-frame mesh to the same WORLD result as its baked twin', () => {
    const a = clipMeshToHalfSpace(localFrame, NORMAL, OFFSET);
    const b = clipMeshToHalfSpace(bakedTwin, NORMAL, OFFSET);

    expect(a.mesh).not.toBeNull();
    expect(b.mesh).not.toBeNull();
    expect(sortedVertexKeys(a.mesh as MeshData)).toEqual(sortedVertexKeys(b.mesh as MeshData));
    expect(totalLength(a.rimSegments)).toBeCloseTo(totalLength(b.rimSegments), 9);
    expect(totalLength(a.rimSegments)).toBeCloseTo(4, 6);
    expect(
      a.rimSegments.map((s) => key([s.start.x, s.start.y, s.start.z])).sort(),
    ).toEqual(b.rimSegments.map((s) => key([s.start.x, s.start.y, s.start.z])).sort());
  });

  it('leaves positions LOCAL and origin untouched (no baking, no double fold)', () => {
    const a = clipMeshToHalfSpace(localFrame, NORMAL, OFFSET);
    const clipped = a.mesh as MeshData;
    expect(clipped.origin).toEqual([100, 0, 0]);
    // Local x runs 0 .. 0.25; if the clipper had baked world coords in, the
    // maximum would be 100.25 and the mesh would render 100 m off.
    const localX: number[] = [];
    for (let i = 0; i < clipped.positions.length / 3; i++) localX.push(clipped.positions[i * 3]);
    expect(Math.max(...localX)).toBeCloseTo(0.25, 6);
    expect(Math.min(...localX)).toBeCloseTo(0, 9);
  });

  it('is unaffected by the offset being expressed against a non-unit normal', () => {
    const unit = clipMeshToHalfSpace(localFrame, NORMAL, OFFSET);
    const scaled = clipMeshToHalfSpace(localFrame, vec3(3, 0, 0), OFFSET * 3);
    expect(sortedVertexKeys(scaled.mesh as MeshData)).toEqual(
      sortedVertexKeys(unit.mesh as MeshData),
    );
  });
});

describe('clipMeshToHalfSpace — untouched and fully-removed geometry', () => {
  it('returns the INPUT mesh by reference when nothing is cut', () => {
    const cube = boxMesh([0, 0, 0], [1, 1, 1]);
    const result = clipMeshToHalfSpace(cube, vec3(1, 0, 0), 5);
    expect(result.mesh).toBe(cube);
    expect(result.rimSegments).toEqual([]);
  });

  it('returns a null mesh when every triangle is removed', () => {
    const cube = boxMesh([0, 0, 0], [1, 1, 1]);
    const result = clipMeshToHalfSpace(cube, vec3(1, 0, 0), -5);
    expect(result.mesh).toBeNull();
    expect(result.rimSegments).toEqual([]);
  });

  it('keeps fully-kept triangles unchanged and drops fully-dropped ones', () => {
    // Box A spans x 0..1 (kept), box B spans x 3..4 (dropped), plane at x = 2
    // touches neither: no triangle is actually clipped, so the surviving
    // geometry must be box A verbatim and there must be no rim.
    const mesh = twoBoxMesh();
    const result = clipMeshToHalfSpace(mesh, vec3(1, 0, 0), 2);

    expect(result.mesh).not.toBeNull();
    expect(result.mesh).not.toBe(mesh); // it DID change: box B is gone
    expect(result.rimSegments).toEqual([]);

    const clipped = result.mesh as MeshData;
    expect(clipped.indices.length / 3).toBe(12); // box A's 12 triangles, all of them
    for (const [x] of worldVertices(clipped)) {
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Box A's own 8 corners, and nothing invented in between.
    expect(new Set(sortedVertexKeys(clipped)).size).toBe(8);
  });

  it('preserves element identity fields on the clipped mesh', () => {
    const mesh = twoBoxMesh();
    const clipped = clipMeshToHalfSpace(mesh, vec3(1, 0, 0), 2).mesh as MeshData;
    expect(clipped.expressId).toBe(7);
    expect(clipped.ifcType).toBe('IfcSlab');
    expect(clipped.modelIndex).toBe(0);
    expect(clipped.color).toEqual([1, 1, 1, 1]);
  });

  it('rejects a degenerate plane instead of silently keeping everything', () => {
    const cube = boxMesh([0, 0, 0], [1, 1, 1]);
    expect(() => clipMeshToHalfSpace(cube, vec3(0, 0, 0), 1)).toThrow(/zero-length|non-finite/i);
    expect(() => clipMeshToHalfSpace(cube, vec3(1, 0, 0), Number.NaN)).toThrow(/non-finite/i);
  });
});

describe('clipMeshesToHalfSpace', () => {
  it('drops vanished meshes and pools the rim of every clipped one', () => {
    const kept = boxMesh([0, 0, 0], [1, 1, 1]);
    const cut = boxMesh([0, 2, 0], [1, 3, 1]);
    const gone = boxMesh([5, 0, 0], [6, 1, 1]);

    const result = clipMeshesToHalfSpace([kept, cut, gone], vec3(1, 0, 0), 0.25);

    expect(result.meshes).toHaveLength(2);
    // Two independent cubes, each contributing a 4.0 m closed rim loop.
    expect(totalLength(result.rimSegments)).toBeCloseTo(8, 9);
    for (const mesh of result.meshes) {
      for (const [x] of worldVertices(mesh)) expect(x).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });
});
