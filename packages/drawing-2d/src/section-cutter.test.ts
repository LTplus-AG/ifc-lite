/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { SectionCutter } from './section-cutter.js';
import { vec3, vec3Normalize, vec3Cross, vec3Dot } from './math.js';
import type { Vec3, SectionPlaneConfig } from './types.js';

/**
 * A large flat quad (2 triangles), placed so that EVERY vertex lies exactly
 * (in double precision, before Float32Array storage) on the given cut plane.
 * `L` is the half-extent of the quad, i.e. the vertex coordinate magnitude —
 * per-element RTC origins mean this models a single large element's own
 * extent (an alignment, a bridge deck, a big roof), not distance from the
 * model origin.
 */
function buildCoplanarQuad(L: number, normal: Vec3, distance: number): MeshData {
  const n = vec3Normalize(normal);
  const arbitrary = Math.abs(n.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  const t = vec3Normalize(vec3Cross(n, arbitrary));
  const b = vec3Cross(n, t);
  const p0 = vec3(distance * n.x, distance * n.y, distance * n.z);

  const corner = (s: number, u: number) => ({
    x: p0.x + s * L * t.x + u * L * b.x,
    y: p0.y + s * L * t.y + u * L * b.y,
    z: p0.z + s * L * t.z + u * L * b.z,
  });
  const c00 = corner(-0.5, -0.5);
  const c10 = corner(0.5, -0.5);
  const c11 = corner(0.5, 0.5);
  const c01 = corner(-0.5, 0.5);

  for (const c of [c00, c10, c11, c01]) {
    const trueD = vec3Dot(c, n) - distance;
    if (Math.abs(trueD) > 1e-9) throw new Error(`test fixture bug: corner not on plane (${trueD})`);
  }

  return {
    expressId: 1,
    ifcType: 'IfcSlab',
    modelIndex: 0,
    positions: new Float32Array([
      c00.x, c00.y, c00.z,
      c10.x, c10.y, c10.z,
      c11.x, c11.y, c11.z,
      c01.x, c01.y, c01.z,
    ]),
    normals: new Float32Array(4 * 3),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
    origin: [0, 0, 0],
  } as unknown as MeshData;
}

const TILTED_NORMAL: Vec3 = { x: 1, y: 1, z: 0.5 };

function cutterFor(distance: number): SectionCutter {
  const n = vec3Normalize(TILTED_NORMAL);
  const config: SectionPlaneConfig = {
    axis: 'y',
    position: 0,
    flipped: false,
    customPlane: {
      normal: n,
      distance,
      origin: vec3(distance * n.x, distance * n.y, distance * n.z),
      tangent: vec3(1, 0, 0),
      bitangent: vec3(0, 1, 0),
    },
  };
  return new SectionCutter(config);
}

describe('SectionCutter — plane-side classification epsilon (candidate a)', () => {
  const DISTANCE = 12.3456;

  it('a face lying exactly on a tilted custom cut plane emits NO segments at ordinary building scale (1m)', () => {
    // Regression for the bug this test guards: with the fixed EPSILON=1e-7,
    // this failed even at L=1 — dot(v, tilted-normal) sums three
    // float32-quantized components, so even a "true" distance of 0 carries
    // ~1e-6 rounding noise, an order of magnitude above 1e-7. That pushed the
    // face out of the "on-plane, skip" branch into the general lerp branch,
    // where dividing two noise terms produced a WILD extrapolated point
    // (metres away, not a tiny nudge) instead of correctly emitting nothing.
    const mesh = buildCoplanarQuad(1, TILTED_NORMAL, DISTANCE);
    const result = cutterFor(DISTANCE).cutSingleMesh(mesh);
    expect(result.segments).toEqual([]);
  });

  it('the same coplanar face emits NO segments at a large single-element scale (100km)', () => {
    const mesh = buildCoplanarQuad(100_000, TILTED_NORMAL, DISTANCE);
    const result = cutterFor(DISTANCE).cutSingleMesh(mesh);
    expect(result.segments).toEqual([]);
  });

  it('a genuinely crossing triangle at ordinary scale is unaffected (bit-identical to the un-scaled epsilon)', () => {
    // Axis-aligned cut through an ordinary small triangle, far from
    // degenerate — the scale-aware epsilon must not perturb ordinary output.
    const mesh: MeshData = {
      expressId: 7,
      ifcType: 'IfcWall',
      modelIndex: 0,
      positions: new Float32Array([
        0, -1, 0,
        1, 1, 0,
        -1, 1, 1,
      ]),
      normals: new Float32Array(3 * 3),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      origin: [0, 0, 0],
    } as unknown as MeshData;
    const cutter = new SectionCutter({ axis: 'y', position: 0, flipped: false });
    const result = cutter.cutSingleMesh(mesh);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].p0_2d).toEqual({ x: 0.5, y: 0 });
    expect(result.segments[0].p1_2d).toEqual({ x: -0.5, y: 0.5 });
  });

  it('a small element at a large RTC origin still detects a genuine near-plane crossing (#2622)', () => {
    // Regression for the OPPOSITE failure from the two tests above: a 2m
    // element (local coordinate magnitude ~2) sitting at a large per-mesh
    // RTC origin (500,000 in x/z — irrelevant to the y=0 cut plane, but the
    // buggy code folds ALL of v0/v1/v2's world-lifted x/y/z components into
    // one `maxCoord`). If the plane-classification epsilon is sized off the
    // WORLD-lifted vertex magnitude (~500,000 → eps ≈ 0.119) instead of the
    // element's own LOCAL magnitude (~2 → eps ≈ 4.8e-7), a real 0.01-unit
    // crossing gets swallowed as "vertex on the plane" and the segment is
    // dropped — exactly the reverse of the coplanar-face bug this file
    // otherwise guards: real geometry vanishes instead of noise appearing.
    const mesh: MeshData = {
      expressId: 9,
      ifcType: 'IfcWall',
      modelIndex: 0,
      positions: new Float32Array([
        0, -0.01, 0,
        1, 1, 0,
        -1, 1, 1,
      ]),
      normals: new Float32Array(3 * 3),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      origin: [500_000, 0, 500_000],
    } as unknown as MeshData;
    const cutter = new SectionCutter({ axis: 'y', position: 0, flipped: false });
    const result = cutter.cutSingleMesh(mesh);
    expect(result.segments).toHaveLength(1);
  });
});
