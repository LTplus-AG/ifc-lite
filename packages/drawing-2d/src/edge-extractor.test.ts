/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig } from './types.js';
import { EdgeExtractor } from './edge-extractor.js';
import { weldVertices } from './edge-weld.js';
import { SectionCutter } from './section-cutter.js';
import { getViewDirectionForPlane, projectPointForPlane } from './projection-bands.js';

// Plan section at world-Y = 1, matching the pattern used in projection-bands.test.ts.
const planPlane: SectionPlaneConfig = { axis: 'y', position: 1, flipped: false };

// Axis-aligned box in the mesh's LOCAL frame, spanning X[0,2] Y[y0,y1] Z[0,2].
// `origin` (when given) is the per-mesh world offset: world = origin + local.
function boxMesh(
  expressId: number,
  y0: number,
  y1: number,
  origin?: [number, number, number],
): MeshData {
  const positions = new Float32Array([
    0, y0, 0, 2, y0, 0, 2, y0, 2, 0, y0, 2, // bottom (y0)
    0, y1, 0, 2, y1, 0, 2, y1, 2, 0, y1, 2, // top (y1)
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (−Y)
    4, 5, 6, 4, 6, 7, // top (+Y)
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  const mesh: MeshData = {
    expressId,
    ifcType: 'IfcRoof',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [1, 1, 1, 1],
  };
  if (origin) mesh.origin = origin;
  return mesh;
}

describe('EdgeExtractor origin lift (world = origin + local)', () => {
  it('lifts extracted edge vertices by the per-mesh origin (RED before the fix)', () => {
    const extractor = new EdgeExtractor(30);
    const origin: [number, number, number] = [500, 0, 500];
    const localMesh = boxMesh(1, 0, 0.5);
    const worldMesh = boxMesh(1, 0, 0.5, origin);

    const localEdges = extractor.extractEdges(localMesh);
    const worldEdges = extractor.extractEdges(worldMesh);

    expect(worldEdges.length).toBe(localEdges.length);
    for (let i = 0; i < localEdges.length; i++) {
      expect(worldEdges[i].v0.x).toBeCloseTo(localEdges[i].v0.x + origin[0], 5);
      expect(worldEdges[i].v0.y).toBeCloseTo(localEdges[i].v0.y + origin[1], 5);
      expect(worldEdges[i].v0.z).toBeCloseTo(localEdges[i].v0.z + origin[2], 5);
      expect(worldEdges[i].v1.x).toBeCloseTo(localEdges[i].v1.x + origin[0], 5);
      expect(worldEdges[i].v1.y).toBeCloseTo(localEdges[i].v1.y + origin[1], 5);
      expect(worldEdges[i].v1.z).toBeCloseTo(localEdges[i].v1.z + origin[2], 5);
    }
  });

  it('projects an origin-shifted silhouette footprint into the correct world-space band (RED before the fix)', () => {
    const extractor = new EdgeExtractor(30);
    const origin: [number, number, number] = [500, 0, 500];
    // Box below the cut (Y=1) in WORLD space once lifted: local Y[0,0.5] + origin.y(0) = world Y[0,0.5].
    const mesh = boxMesh(40, 0, 0.5, origin);
    const edges = extractor.extractEdges(mesh);
    const viewDir = getViewDirectionForPlane(planPlane);
    const silhouettes = extractor.extractSilhouettes(edges, viewDir);
    const lines = extractor.edgesToProjectionLines(silhouettes, planPlane, { below: 3, above: 3 });

    // Without the origin lift, local X/Z in [0,2] never reaches the shifted
    // world footprint at X/Z in [500,502] — the lines would either project to
    // the wrong place or, since Y is unaffected here, still appear (band test
    // wouldn't catch it), so we assert directly on projected coordinates.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line.line.start.x).toBeGreaterThanOrEqual(500 - 1e-6);
      expect(line.line.start.x).toBeLessThanOrEqual(502 + 1e-6);
      expect(line.line.end.x).toBeGreaterThanOrEqual(500 - 1e-6);
      expect(line.line.end.x).toBeLessThanOrEqual(502 + 1e-6);
    }
  });

  it('is bit-identical for origin=[0,0,0] and undefined origin (no regression for the common case)', () => {
    const extractor = new EdgeExtractor(30);
    const meshUndefined = boxMesh(2, 0, 1);
    const meshZero = boxMesh(2, 0, 1, [0, 0, 0]);

    const edgesUndefined = extractor.extractEdges(meshUndefined);
    const edgesZero = extractor.extractEdges(meshZero);

    expect(edgesZero.length).toBe(edgesUndefined.length);
    for (let i = 0; i < edgesUndefined.length; i++) {
      expect(edgesZero[i].v0).toEqual(edgesUndefined[i].v0);
      expect(edgesZero[i].v1).toEqual(edgesUndefined[i].v1);
      expect(edgesZero[i].dihedralAngle).toBe(edgesUndefined[i].dihedralAngle);
      expect(edgesZero[i].type).toBe(edgesUndefined[i].type);
    }

    const viewDir = getViewDirectionForPlane(planPlane);
    const linesUndefined = extractor.edgesToProjectionLines(
      extractor.extractSilhouettes(edgesUndefined, viewDir),
      planPlane,
      { below: 3, above: 3 },
    );
    const linesZero = extractor.edgesToProjectionLines(
      extractor.extractSilhouettes(edgesZero, viewDir),
      planPlane,
      { below: 3, above: 3 },
    );
    expect(linesZero).toEqual(linesUndefined);
  });

  it('silhouette projection lines coincide with the section-cutter cut polygon at the shared boundary (origin applied to both)', () => {
    const origin: [number, number, number] = [500, 0, 500];
    const extractor = new EdgeExtractor(30);

    // Box A straddles the cut plane (Y=1): SectionCutter slices it and its
    // cut-polygon corners trace the box's XZ footprint at the cut plane.
    const straddling = boxMesh(10, 0.5, 1.5, origin);
    const cutter = new SectionCutter(planPlane);
    const { segments } = cutter.cutSingleMesh(straddling);
    expect(segments.length).toBeGreaterThan(0);
    const cutPoints2D = new Set<string>();
    for (const seg of segments) {
      cutPoints2D.add(`${seg.p0_2d.x.toFixed(3)},${seg.p0_2d.y.toFixed(3)}`);
      cutPoints2D.add(`${seg.p1_2d.x.toFixed(3)},${seg.p1_2d.y.toFixed(3)}`);
    }

    // Box B (same XZ footprint, same origin) sits fully below the cut: its
    // silhouette footprint uses edge-extractor's projection, the same basis
    // (`projectPointForPlane`) the comment on edgesToProjectionLines claims.
    const below = boxMesh(11, 0, 0.5, origin);
    const edges = extractor.extractEdges(below);
    const viewDir = getViewDirectionForPlane(planPlane);
    const silhouettes = extractor.extractSilhouettes(edges, viewDir);
    const lines = extractor.edgesToProjectionLines(silhouettes, planPlane, { below: 3, above: 3 });
    const footprintPoints2D = new Set<string>();
    for (const line of lines) {
      footprintPoints2D.add(`${line.line.start.x.toFixed(3)},${line.line.start.y.toFixed(3)}`);
      footprintPoints2D.add(`${line.line.end.x.toFixed(3)},${line.line.end.y.toFixed(3)}`);
    }

    // The footprint corners (both boxes share the same XZ extent + origin)
    // must coincide with the cut polygon's corners in the shared 2D basis.
    // Sanity-check via the four rectangle corners directly, in world space.
    const corners: Array<[number, number, number]> = [
      [origin[0] + 0, 0, origin[2] + 0],
      [origin[0] + 2, 0, origin[2] + 0],
      [origin[0] + 2, 0, origin[2] + 2],
      [origin[0] + 0, 0, origin[2] + 2],
    ];
    for (const [x, y, z] of corners) {
      const p2d = projectPointForPlane({ x, y, z }, planPlane);
      const key = `${p2d.x.toFixed(3)},${p2d.y.toFixed(3)}`;
      expect(cutPoints2D.has(key)).toBe(true);
      expect(footprintPoints2D.has(key)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue #2682 — winding-robust silhouettes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The same mesh with every triangle's last two indices swapped: identical
 * positions, identical edges, every face wound INWARD.
 */
function reverseWinding(mesh: MeshData): MeshData {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    indices[t] = mesh.indices[t];
    indices[t + 1] = mesh.indices[t + 2];
    indices[t + 2] = mesh.indices[t + 1];
  }
  return { ...mesh, indices };
}

/** Order-independent identity of a projection line: endpoints + band + depth. */
function lineKey(line: {
  line: { start: { x: number; y: number }; end: { x: number; y: number } };
  visibility: string;
  depth?: number;
  depthEnd?: number;
}): string {
  const a = `${line.line.start.x.toFixed(6)},${line.line.start.y.toFixed(6)}`;
  const b = `${line.line.end.x.toFixed(6)},${line.line.end.y.toFixed(6)}`;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const depths = [line.depth ?? 0, line.depthEnd ?? line.depth ?? 0]
    .map((d) => d.toFixed(6))
    .sort();
  return `${lo}|${hi}|${line.visibility}|${depths.join('~')}`;
}

function silhouetteLinesFor(mesh: MeshData) {
  const extractor = new EdgeExtractor(30);
  const edges = extractor.extractEdges(mesh);
  const silhouettes = extractor.extractSilhouettes(edges, getViewDirectionForPlane(planPlane));
  return extractor.edgesToProjectionLines(silhouettes, planPlane, { below: 3, above: 3 });
}

describe('EdgeExtractor winding robustness (issue #2682)', () => {
  // A TALL element (local Y in [-5, 0.5]) cut in plan at Y = 1 with a 3 m
  // projection band: the NEAR rim (Y = 0.5) is in band, the FAR rim (Y = -5)
  // is not. The winding-sensitive silhouette test picks the far rim on an
  // inward-wound solid, and the band then drops it — a blank drawing.
  //
  // NOTE: this file's shared `boxMesh` is itself wound INWARD (signed volume
  // -4 for the 2 x h x 2 box). That is not a slip in the fixture, it is
  // ifc-lite winding in the wild, and it is why the tests above never noticed:
  // their boxes are short enough for the far rim to stay inside the band. The
  // outward-wound twin is the REVERSED one.
  const tallInward = () => boxMesh(7, -5, 0.5);
  const tallOutward = () => reverseWinding(boxMesh(7, -5, 0.5));

  it('gives an inward-wound solid the same silhouette line work as its outward twin', () => {
    const outward = silhouetteLinesFor(tallOutward());
    const inward = silhouetteLinesFor(tallInward());

    // Existence first, so the equality below cannot pass on two empty sets.
    expect(outward.length).toBe(4);
    expect(inward.length).toBe(4);
    expect(inward.map(lineKey).sort()).toEqual(outward.map(lineKey).sort());
  });

  // CONTROL, not a guard: an open sheet has no enclosed volume, so the
  // orientation test is inconclusive and the mesh is left alone. This is green
  // both with and without the fix by construction — its job is to pin that a
  // zero-volume mesh survives the new code path unchanged, not to catch a
  // regression in it. The falsifiable anti-overcorrection assertion is
  // `expect(outward.length).toBe(4)` above: invert the sign test and a
  // correctly wound solid loses its near rim.
  it('leaves an open (zero-volume) sheet alone — the orientation test stays inconclusive', () => {
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]);
    const sheet: MeshData = {
      expressId: 8,
      ifcType: 'IfcSlab',
      modelIndex: 0,
      positions,
      normals: new Float32Array(positions.length),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [1, 1, 1, 1],
    };
    const outward = silhouetteLinesFor(sheet);
    const inward = silhouetteLinesFor(reverseWinding(sheet));

    expect(outward.length).toBeGreaterThan(0);
    expect(inward.map(lineKey).sort()).toEqual(outward.map(lineKey).sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Adjacency by POSITION, not by buffer index (issue #8161)
// ═══════════════════════════════════════════════════════════════════════════

/** One f32 ULP at |x| (x a normal, non-zero f32 value). */
function f32Ulp(x: number): number {
  return 2 ** (Math.floor(Math.log2(Math.abs(x))) - 23);
}

/**
 * Axis-aligned cube of side `size` at `base`, meshed with FOUR VERTICES PER
 * FACE (24 vertices, 8 distinct positions), the layout the geometry pipeline
 * emits for flat-shaded solids. `jitter(copy)` returns a per-axis offset in
 * f32 ULPs applied to the `copy`-th duplicate of a corner (copy 0 is never
 * jittered, so it carries the exact corner position).
 */
function perFaceCube(
  size: number,
  base: [number, number, number] = [0, 0, 0],
  opts: { origin?: [number, number, number]; jitter?: (copy: number) => number } = {},
): MeshData {
  const corner = (c: number): [number, number, number] => [
    base[0] + (c & 1 ? size : 0),
    base[1] + (c & 2 ? size : 0),
    base[2] + (c & 4 ? size : 0),
  ];
  // Outward-wound quads over corner ids (bit0 = +X, bit1 = +Y, bit2 = +Z).
  const faces = [
    [0, 2, 3, 1], [4, 5, 7, 6], // -Z, +Z
    [0, 1, 5, 4], [2, 6, 7, 3], // -Y, +Y
    [0, 4, 6, 2], [1, 3, 7, 5], // -X, +X
  ];
  const copies = new Map<number, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (const face of faces) {
    const start = pos.length / 3;
    for (const c of face) {
      const copy = copies.get(c) ?? 0;
      copies.set(c, copy + 1);
      const p = corner(c);
      const j = copy === 0 || !opts.jitter ? 0 : opts.jitter(copy);
      for (const v of p) pos.push(v + j * f32Ulp(Math.fround(v)));
    }
    idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const positions = new Float32Array(pos);
  const mesh: MeshData = {
    expressId: 9,
    ifcType: 'IfcColumn',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(idx),
    color: [1, 1, 1, 1],
  };
  if (opts.origin) mesh.origin = opts.origin;
  return mesh;
}

function typeCounts(edges: { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of edges) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

describe('EdgeExtractor adjacency by position (issue #8161)', () => {
  function quad(shared: boolean): MeshData {
    const positions = shared
      ? new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2])
      : new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 0, 2, 0, 2, 0, 0, 2]);
    return {
      expressId: 1,
      ifcType: 'IfcSlab',
      modelIndex: 0,
      positions,
      normals: new Float32Array(positions.length),
      indices: shared ? new Uint32Array([0, 1, 2, 0, 2, 3]) : new Uint32Array([0, 1, 2, 3, 4, 5]),
      color: [1, 1, 1, 1],
    };
  }

  it('a quad with per-triangle vertices has the same 4 boundary edges as the shared-vertex quad', () => {
    const shared = new EdgeExtractor().extractEdges(quad(true));
    const dup = new EdgeExtractor().extractEdges(quad(false));
    expect(typeCounts(shared)).toEqual({ boundary: 4 });
    expect(typeCounts(dup)).toEqual({ boundary: 4 });
  });

  it('a closed per-face cube has no boundary edges and 12 crease edges', () => {
    const edges = new EdgeExtractor(30).extractEdges(perFaceCube(2));
    expect(typeCounts(edges)).toEqual({ crease: 12 });
    for (const e of edges) expect(e.dihedralAngle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('emits each edge at the exact corner positions (representative = first duplicate)', () => {
    const edges = new EdgeExtractor().extractEdges(perFaceCube(2, [0, 0, 0], { jitter: () => 1 }));
    const corners = new Set<string>();
    for (const x of [0, 2]) for (const y of [0, 2]) for (const z of [0, 2]) corners.add(`${x},${y},${z}`);
    expect(edges.length).toBe(12);
    for (const e of edges) {
      expect(corners.has(`${e.v0.x},${e.v0.y},${e.v0.z}`)).toBe(true);
      expect(corners.has(`${e.v1.x},${e.v1.y},${e.v1.z}`)).toBe(true);
    }
  });

  it('a large per-mesh origin (georeferenced RTC frame) changes nothing but the coordinates', () => {
    const origin: [number, number, number] = [512_345.25, 48.5, -5_412_345.75];
    const local = new EdgeExtractor().extractEdges(perFaceCube(2));
    const shifted = new EdgeExtractor().extractEdges(perFaceCube(2, [0, 0, 0], { origin }));
    expect(typeCounts(shifted)).toEqual({ crease: 12 });
    const key = (e: { v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number } }, o = [0, 0, 0]) =>
      [e.v0, e.v1]
        .map((v) => `${v.x - o[0]},${v.y - o[1]},${v.z - o[2]}`)
        .sort()
        .join('|');
    expect(shifted.map((e) => key(e, origin)).sort()).toEqual(local.map((e) => key(e)).sort());
  });

  it('welds duplicates that differ by f32 rounding at absolute georeferenced magnitudes', () => {
    // Positions themselves at ~4e5 m (no per-mesh origin): one f32 ULP is
    // 3.1 cm there, so duplicates rounded along different paths differ by
    // whole centimetres. A fixed sub-millimetre epsilon cannot weld them.
    const base: [number, number, number] = [400_000, 30, 400_100];
    const exact = new EdgeExtractor(30).extractEdges(perFaceCube(1, base));
    const jittered = new EdgeExtractor(30).extractEdges(
      perFaceCube(1, base, { jitter: (copy) => (copy % 2 === 0 ? 1 : -1) }),
    );
    expect(typeCounts(exact)).toEqual({ crease: 12 });
    expect(typeCounts(jittered)).toEqual({ crease: 12 });
  });

  it('does not merge the distinct corners of a sub-millimetre cube near the origin', () => {
    // 50 µm cube: an absolute weld epsilon sized for building coordinates
    // (1e-4 m and up) would collapse it to a point and emit nothing.
    const edges = new EdgeExtractor(30).extractEdges(perFaceCube(5e-5, [0.001, 0.001, 0.001]));
    expect(typeCounts(edges)).toEqual({ crease: 12 });
  });

  it('welds near-duplicates regardless of where they fall relative to the quantisation grid', () => {
    // Sweep the cube across many sub-ULP-grid offsets so that, for some of
    // them, a corner and its 1-ULP-off duplicate land in adjacent grid cells.
    let failures = 0;
    for (let i = 0; i < 200; i++) {
      const b = 3.0 + i * 0.0137;
      const edges = new EdgeExtractor(30).extractEdges(
        perFaceCube(1, [b, b * 1.7, b * 0.3], { jitter: (copy) => (copy % 2 === 0 ? 1 : -1) }),
      );
      const c = typeCounts(edges);
      if (c.crease !== 12 || c.boundary) failures++;
    }
    expect(failures).toBe(0);
  });

  it('skips a zero-area sliver instead of letting it pose as a second face', () => {
    // Shared-vertex quad plus a collinear (zero-area) triangle along its
    // diagonal edge: the sliver must not register as an adjacent face.
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 1, 0, 1]);
    const mesh: MeshData = {
      expressId: 2,
      ifcType: 'IfcSlab',
      modelIndex: 0,
      positions,
      normals: new Float32Array(positions.length),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 4, 2]),
      color: [1, 1, 1, 1],
    };
    expect(typeCounts(new EdgeExtractor().extractEdges(mesh))).toEqual({ boundary: 4 });
  });

  function rawMesh(positions: number[], indices: number[]): MeshData {
    const pos = new Float32Array(positions);
    return {
      expressId: 3,
      ifcType: 'IfcSlab',
      modelIndex: 0,
      positions: pos,
      normals: new Float32Array(pos.length),
      indices: new Uint32Array(indices),
      color: [1, 1, 1, 1],
    };
  }

  it('reports a non-manifold edge shared by three faces once, classified from its first two faces', () => {
    // Three fins on the segment (0,0,0)-(1,0,0): +Y, +Z and -Y, each with
    // its own (unshared) vertices. Fins 0 and 1 are perpendicular.
    const mesh = rawMesh(
      [0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 0.5, -1, 0],
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    const edges = new EdgeExtractor(30).extractEdges(mesh);
    const shared = edges.filter((e) => e.v0.y === 0 && e.v0.z === 0 && e.v1.y === 0 && e.v1.z === 0);
    expect(shared).toHaveLength(1);
    expect(shared[0].type).toBe('crease');
    // 1 shared + 2 free sides per fin.
    expect(edges).toHaveLength(7);
  });

  it('does not report a coincident duplicate triangle as boundary edges', () => {
    // The same triangle twice, with separate vertices: both faces have the
    // same normal, so every edge is a smooth edge between two faces.
    const tri = [0, 0, 0, 2, 0, 0, 0, 0, 2];
    const mesh = rawMesh([...tri, ...tri], [0, 1, 2, 3, 4, 5]);
    expect(new EdgeExtractor(30).extractEdges(mesh)).toEqual([]);
  });

  it('treats an opposite-wound coincident triangle as a fold: every edge is a crease', () => {
    const mesh = rawMesh([0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 2, 2, 0, 0], [0, 1, 2, 3, 4, 5]);
    expect(typeCounts(new EdgeExtractor(30).extractEdges(mesh))).toEqual({ crease: 3 });
  });

  it('ignores a triangle that collapses to a segment under the weld', () => {
    // Quad plus a triangle whose first two corners differ by 1e-7 m at 2 m
    // magnitude (weld tolerance 4.8e-7 m), so it welds down to a segment and
    // has no face; the quad keeps its 4 boundary edges and gains nothing.
    const mesh = rawMesh(
      [0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 1, 0, 1, 1 + 1e-7, 0, 1, 1.5, 0, 1.5],
      [0, 1, 2, 0, 2, 3, 4, 5, 6],
    );
    expect(typeCounts(new EdgeExtractor().extractEdges(mesh))).toEqual({ boundary: 4 });
  });

  it('ignores a near-collinear sliver whose height is below the weld tolerance', () => {
    // Quad plus a triangle on its diagonal with a 1e-8 m height (non-zero
    // area, but under the 4.8e-7 m tolerance at 2 m magnitude).
    const mesh = rawMesh(
      [0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 0, 0, 0, 2, 0, 2, 1, 1e-8, 1],
      [0, 1, 2, 0, 2, 3, 4, 5, 6],
    );
    expect(typeCounts(new EdgeExtractor().extractEdges(mesh))).toEqual({ boundary: 4 });
  });

  it('welds a vertex within tolerance of two representatives to the earlier one, across cells', () => {
    // maxAbs 1 gives tolerance 2^-22; the first two vertices sit 1.8 tolerances
    // apart (separate representatives, in adjacent cells) and the third lies
    // within tolerance of both, in the same cell as the SECOND.
    const t = 2 ** -22;
    expect(weldVertices(new Float32Array([0, -0.9 * t, 1, 0, 0.9 * t, 1, 0, 0, 1])).rep).toEqual(
      new Uint32Array([0, 1, 0]),
    );
  });
});
