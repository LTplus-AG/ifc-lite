/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCapFillGeometry,
  buildDrawingOutlineVertices,
  createSectionLift,
  transform2Dto3D,
  type CutPolygon2D,
  type DrawingLine2D,
} from './section-2d-lift.js';

/**
 * The 2D→3D lift is the #243 / #581 contract: the cap polygons have to land on
 * the SAME plane the cutter projected them from, or the section cap floats off
 * the user's plane. It ran unguarded until this file — `section-2d-overlay.ts`
 * had no direct coverage at all, so every one of these behaviours could be
 * changed without a single test going red.
 */

const FLOATS_PER_VERTEX = 7; // x,y,z,r,g,b,a

function poly(
  outer: Array<[number, number]>,
  holes: Array<Array<[number, number]>> = [],
  color?: [number, number, number, number],
): CutPolygon2D {
  return {
    polygon: {
      outer: outer.map(([x, y]) => ({ x, y })),
      holes: holes.map((h) => h.map(([x, y]) => ({ x, y }))),
    },
    ifcType: 'IfcWall',
    expressId: 1,
    ...(color ? { color } : {}),
  };
}

function line(x1: number, y1: number, x2: number, y2: number): DrawingLine2D {
  return { line: { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }, category: 'cut' };
}

/** Sum of the triangle areas of an indexed 3D mesh. */
function triangulatedArea(vertices: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const p: Array<[number, number, number]> = [];
    for (let k = 0; k < 3; k++) {
      const base = indices[i + k] * FLOATS_PER_VERTEX;
      p.push([vertices[base], vertices[base + 1], vertices[base + 2]]);
    }
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    total += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return total;
}

describe('transform2Dto3D: cardinal axes', () => {
  it("maps 'down' (Y cut, floor plan) 2D (x,y) to 3D (x, plane, y)", () => {
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'down', 2.5), [3, 2.5, 7]);
  });

  it("maps 'front' (Z cut, section) 2D (x,y) to 3D (x, y, plane)", () => {
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'front', 2.5), [3, 7, 2.5]);
  });

  it("maps 'side' (X cut, elevation) 2D (x,y) to 3D (plane, y, x)", () => {
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'side', 2.5), [2.5, 7, 3]);
  });

  it('negates ONLY the 2D x coordinate when flipped', () => {
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'down', 2.5, true), [-3, 2.5, 7]);
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'front', 2.5, true), [-3, 7, 2.5]);
    // 'side' puts the mirrored x into the Z slot, not the X slot.
    assert.deepStrictEqual(transform2Dto3D(3, 7, 'side', 2.5, true), [2.5, 7, -3]);
  });

  it('leaves the plane coordinate alone when flipped', () => {
    const [, y] = transform2Dto3D(3, 7, 'down', 2.5, true);
    assert.strictEqual(y, 2.5);
  });
});

describe('transform2Dto3D: custom plane (#243)', () => {
  const plane = {
    origin: [10, 20, 30] as [number, number, number],
    tangent: [0, 1, 0] as [number, number, number],
    bitangent: [0, 0, 1] as [number, number, number],
  };

  it('lifts via origin + tangent*x + bitangent*y', () => {
    assert.deepStrictEqual(transform2Dto3D(2, 5, 'down', 999, false, plane), [10, 22, 35]);
  });

  it('IGNORES flipped for a custom plane (the cutter does not mirror arbitrary planes)', () => {
    const unflipped = transform2Dto3D(2, 5, 'down', 999, false, plane);
    const flipped = transform2Dto3D(2, 5, 'down', 999, true, plane);
    assert.deepStrictEqual(flipped, unflipped);
  });

  it('IGNORES the cardinal axis and plane position for a custom plane', () => {
    const viaDown = transform2Dto3D(2, 5, 'down', 0, false, plane);
    const viaSide = transform2Dto3D(2, 5, 'side', -100, false, plane);
    assert.deepStrictEqual(viaSide, viaDown);
  });

  it('round-trips a tilted basis exactly (cap lands ON the plane, not beside it)', () => {
    const s = Math.SQRT1_2;
    const tilted = {
      origin: [1, 2, 3] as [number, number, number],
      tangent: [s, s, 0] as [number, number, number],
      bitangent: [0, 0, 1] as [number, number, number],
    };
    const [x, y, z] = transform2Dto3D(4, -2, 'front', 0, false, tilted);
    // Project back onto the basis: the 2D coordinates must come out unchanged.
    const dx = x - 1, dy = y - 2, dz = z - 3;
    const u = dx * tilted.tangent[0] + dy * tilted.tangent[1] + dz * tilted.tangent[2];
    const v = dx * tilted.bitangent[0] + dy * tilted.bitangent[1] + dz * tilted.bitangent[2];
    assert.ok(Math.abs(u - 4) < 1e-12, `tangent coord round-trip: ${u}`);
    assert.ok(Math.abs(v - -2) < 1e-12, `bitangent coord round-trip: ${v}`);
  });
});

describe('createSectionLift', () => {
  it('binds the same mapping transform2Dto3D produces', () => {
    const lift = createSectionLift('side', 4, true);
    assert.deepStrictEqual(lift(3, 7), transform2Dto3D(3, 7, 'side', 4, true));
  });

  it('carries the custom plane through the binding', () => {
    const plane = {
      origin: [0, 0, 5] as [number, number, number],
      tangent: [1, 0, 0] as [number, number, number],
      bitangent: [0, 1, 0] as [number, number, number],
    };
    const lift = createSectionLift('down', 0, false, plane);
    assert.deepStrictEqual(lift(2, 3), [2, 3, 5]);
  });
});

describe('buildCapFillGeometry', () => {
  it('returns null when nothing is triangulable', () => {
    const lift = createSectionLift('front', 0);
    assert.strictEqual(buildCapFillGeometry([], lift), null);
    // A two-point "polygon" has no area.
    assert.strictEqual(buildCapFillGeometry([poly([[0, 0], [1, 0]])], lift), null);
  });

  it('lifts a unit square onto the requested plane and preserves its area', () => {
    const lift = createSectionLift('down', 12);
    const geom = buildCapFillGeometry([poly([[0, 0], [2, 0], [2, 2], [0, 2]])], lift);
    assert.ok(geom);
    assert.strictEqual(geom.vertices.length, 4 * FLOATS_PER_VERTEX);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(geom.vertices[i * FLOATS_PER_VERTEX + 1], 12, 'every vertex on the plane');
    }
    assert.ok(Math.abs(triangulatedArea(geom.vertices, geom.indices) - 4) < 1e-5);
  });

  it('tags colourless polygons with the sentinel alpha -1 so the shader uses the cap style', () => {
    const geom = buildCapFillGeometry(
      [poly([[0, 0], [1, 0], [1, 1]])],
      createSectionLift('front', 0),
    );
    assert.ok(geom);
    assert.deepStrictEqual(
      Array.from(geom.vertices.slice(3, 7)),
      [0, 0, 0, -1],
    );
  });

  it("carries a polygon's own RGBA onto every one of its vertices", () => {
    const geom = buildCapFillGeometry(
      [poly([[0, 0], [1, 0], [1, 1]], [], [0.25, 0.5, 0.75, 1])],
      createSectionLift('front', 0),
    );
    assert.ok(geom);
    for (let v = 0; v < geom.vertices.length / FLOATS_PER_VERTEX; v++) {
      assert.deepStrictEqual(
        Array.from(geom.vertices.slice(v * FLOATS_PER_VERTEX + 3, v * FLOATS_PER_VERTEX + 7)),
        [0.25, 0.5, 0.75, 1],
      );
    }
  });

  it('triangulates a CONCAVE cross-section to its true area (the old convex fan inverted here)', () => {
    // L-shape, area 3 of a 2x2 bounding box.
    const l = poly([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]);
    const geom = buildCapFillGeometry([l], createSectionLift('front', 0));
    assert.ok(geom);
    const area = triangulatedArea(geom.vertices, geom.indices);
    assert.ok(Math.abs(area - 3) < 1e-5, `concave area was ${area}, expected 3`);
  });

  it('stitches a hole ring into the outer ring rather than ignoring it', () => {
    const withHole = poly(
      [[0, 0], [4, 0], [4, 4], [0, 4]],
      [[[1, 1], [1, 3], [3, 3], [3, 1]]],
    );
    const geom = buildCapFillGeometry([withHole], createSectionLift('front', 0));
    assert.ok(geom);
    // 4 outer + 4 hole + 2 bridge duplicates.
    assert.strictEqual(geom.vertices.length / FLOATS_PER_VERTEX, 10);
    const area = triangulatedArea(geom.vertices, geom.indices);
    assert.ok(area < 16, `a holed cut face must not cover the full outer ring (got ${area})`);

    // KNOWN GAP, deliberately not pinned to a number here: the shared
    // `earClip` in symbolic-overlay-pipelines.ts under-triangulates the bridged
    // ring, because its `pointInTriangle` treats on-edge points as contained
    // and the bridge duplicates two vertices — so every candidate ear looks
    // like it contains another vertex and almost none are clipped. That is a
    // defect in the triangulator, not in the lift, and asserting the current
    // (too small) area here would turn fixing it into a red test.
  });

  it('drops degenerate holes (<3 points) instead of corrupting the ring', () => {
    const withStub = poly([[0, 0], [4, 0], [4, 4], [0, 4]], [[[1, 1], [2, 2]]]);
    const geom = buildCapFillGeometry([withStub], createSectionLift('front', 0));
    assert.ok(geom);
    assert.strictEqual(geom.vertices.length / FLOATS_PER_VERTEX, 4);
    assert.ok(Math.abs(triangulatedArea(geom.vertices, geom.indices) - 16) < 1e-5);
  });

  it('offsets indices per polygon so the second polygon does not index the first', () => {
    const a = poly([[0, 0], [1, 0], [1, 1]]);
    const b = poly([[5, 5], [6, 5], [6, 6]]);
    const geom = buildCapFillGeometry([a, b], createSectionLift('front', 0));
    assert.ok(geom);
    assert.strictEqual(geom.vertices.length / FLOATS_PER_VERTEX, 6);
    const maxIndex = Math.max(...Array.from(geom.indices));
    assert.strictEqual(maxIndex, 5, 'indices must reach the second polygon');
    // Total area = both triangles, which only holds if the offsets are right.
    assert.ok(Math.abs(triangulatedArea(geom.vertices, geom.indices) - 1) < 1e-5);
  });

  it('skips a sub-3-point polygon without disturbing the offsets of the next one', () => {
    const stub = poly([[0, 0], [1, 0]]);
    const real = poly([[5, 5], [6, 5], [6, 6]]);
    const geom = buildCapFillGeometry([stub, real], createSectionLift('front', 0));
    assert.ok(geom);
    assert.strictEqual(geom.vertices.length / FLOATS_PER_VERTEX, 3);
    assert.strictEqual(Math.max(...Array.from(geom.indices)), 2);
  });
});

describe('buildDrawingOutlineVertices', () => {
  it('returns null when there are no polygons and no lines', () => {
    assert.strictEqual(
      buildDrawingOutlineVertices([], [], createSectionLift('front', 0)),
      null,
    );
  });

  it('emits one closed segment per outer edge', () => {
    const out = buildDrawingOutlineVertices(
      [poly([[0, 0], [1, 0], [1, 1]])],
      [],
      createSectionLift('front', 9),
    );
    assert.ok(out);
    // 3 edges * 2 vertices * 3 floats
    assert.strictEqual(out.length, 18);
    // Last segment closes the ring back onto the first point.
    assert.deepStrictEqual(Array.from(out.slice(15, 18)), [0, 0, 9]);
  });

  it('emits hole rings as well as the outer ring', () => {
    const out = buildDrawingOutlineVertices(
      [poly([[0, 0], [4, 0], [4, 4], [0, 4]], [[[1, 1], [1, 3], [3, 3]]])],
      [],
      createSectionLift('front', 0),
    );
    assert.ok(out);
    // 4 outer edges + 3 hole edges = 7 segments.
    assert.strictEqual(out.length, 7 * 6);
  });

  it('appends the extra drawing lines after the polygon outlines', () => {
    const out = buildDrawingOutlineVertices(
      [poly([[0, 0], [1, 0], [1, 1]])],
      [line(10, 11, 12, 13)],
      createSectionLift('front', 5),
    );
    assert.ok(out);
    assert.strictEqual(out.length, 4 * 6);
    assert.deepStrictEqual(Array.from(out.slice(18)), [10, 11, 5, 12, 13, 5]);
  });

  it('lifts outline points with the SAME lift as the fill (they must be coplanar)', () => {
    const lift = createSectionLift('side', -3, true);
    const p = poly([[0, 0], [1, 0], [1, 1]]);
    const fill = buildCapFillGeometry([p], lift);
    const out = buildDrawingOutlineVertices([p], [], lift);
    assert.ok(fill && out);
    for (let i = 0; i < out.length; i += 3) {
      assert.strictEqual(out[i], -3, 'outline sits on the section plane');
    }
    assert.strictEqual(fill.vertices[0], -3, 'fill sits on the same plane');
  });

  it('emits lines even when every polygon was too small to fill', () => {
    const out = buildDrawingOutlineVertices(
      [poly([[0, 0], [1, 0]])],
      [],
      createSectionLift('front', 0),
    );
    // Two points still produce two (degenerate) edges — the outline path does
    // not apply the fill path's 3-point minimum.
    assert.ok(out);
    assert.strictEqual(out.length, 2 * 6);
  });
});
