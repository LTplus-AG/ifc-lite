/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig } from './types.js';
import { EdgeExtractor } from './edge-extractor.js';
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
