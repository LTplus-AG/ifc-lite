/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5480: a face-picked section plane must not be coplanar with the picked face.
 *
 * The invariant is asserted the way the GPU evaluates it: the picked face's
 * triangle is drawn from vertices snapped to the quantized-vertex lattice and
 * the clip shader computes `(dot(p, n) - d) * side` in f32, discarding when it
 * is > 0. A plane ON the face leaves that value straddling zero across the
 * face (per-pixel coin toss, plus a depth tie with the cap drawn on the same
 * plane): the speckle from the report. The committed plane must put the whole
 * face strictly on one side, for both kept sides.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { QUANT_STEP } from '@ifc-lite/renderer';
import { createSectionSlice, type SectionSlice } from './sectionSlice.js';
import { cardinalSectionFlipped } from '../section-active.js';
import { FACE_PICK_MAX_INSET_M, FACE_PICK_MIN_INSET_M, facePickInset } from './sectionFacePick.js';

type Vec3 = [number, number, number];

const f = Math.fround;
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const snap = (p: Vec3): Vec3 => p.map((v) => Math.round(v / QUANT_STEP) * QUANT_STEP) as Vec3;

/** The main shader's clip value for one vertex, in f32 like the GPU computes it. */
function clipValue(p: Vec3, n: Vec3, d: number, flipped: boolean): number {
  const along = f(f(f(f(p[0]) * f(n[0])) + f(f(p[1]) * f(n[1]))) + f(f(p[2]) * f(n[2])));
  return f(f(along - f(d)) * (flipped ? -1 : 1));
}

function commitPick(normal: Vec3, point: Vec3, bounds?: { min: Vec3; max: Vec3 }) {
  const store = create<SectionSlice>()((...a) => createSectionSlice(...a));
  store.getState().setSectionPickMode(true);
  store.getState().setSectionPlaneFromFace(normal, point, bounds);
  const { sectionPlane } = store.getState();
  assert.ok(sectionPlane.custom, 'the pick committed a custom plane');
  return sectionPlane.custom;
}

/** A tilted roof-like face (normal ≈ (0, 0.87, 0.5), the #5480 repro) around `origin`. */
function roofFace(origin: Vec3): { normal: Vec3; vertices: Vec3[] } {
  const normal: Vec3 = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const t: Vec3 = [1, 0, 0];
  const b: Vec3 = [0, -normal[2], normal[1]]; // in-plane, ⟂ t and n
  const at = (s: number, u: number): Vec3 => [
    origin[0] + t[0] * s + b[0] * u,
    origin[1] + t[1] * s + b[1] * u,
    origin[2] + t[2] * s + b[2] * u,
  ];
  // Irregular corners so the lattice rounding differs per vertex.
  return { normal, vertices: [at(-4.3217, -2.1113), at(5.0091, -1.7777), at(0.3313, 3.2729)] };
}

describe('face-picked section plane placement (#5480)', () => {
  const bounds = { min: [-7, 0, -6] as Vec3, max: [7, 8, 6] as Vec3 };

  it('puts the whole drawn face strictly on the clipped side, not on the plane', () => {
    const { normal, vertices } = roofFace([0.1234, 5.1616, 1.4142]);
    const custom = commitPick(normal, vertices[0], bounds);
    for (const v of vertices) {
      // Picked point and every drawn (quantized) vertex are outside the plane:
      // the default kept side discards the face on EVERY pixel, so the cap
      // shows the cross-section instead of fighting the face.
      assert.ok(clipValue(snap(v), custom.normal, custom.distance, false) > 0,
        `vertex ${v} must be discarded, clip value ${clipValue(snap(v), custom.normal, custom.distance, false)}`);
      // Flipped, the same face is kept whole (cap sits behind it), never torn.
      assert.ok(clipValue(snap(v), custom.normal, custom.distance, true) < 0);
    }
  });

  it('moves the plane INTO the solid (against the camera-facing normal) by a small inset', () => {
    const point: Vec3 = [1.5, 2.971 / Math.cos(Math.PI / 6), 0];
    const normal: Vec3 = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const custom = commitPick(normal, point, bounds);
    const inset = dot(point, custom.normal as Vec3) - custom.distance;
    assert.ok(inset >= FACE_PICK_MIN_INSET_M - 1e-12, `inset ${inset} below the lattice floor`);
    assert.ok(inset <= 0.005, `a building-scale pick stays within millimetres of the face (inset ${inset})`);
    // The picked point itself is preserved; only the plane is offset.
    assert.deepEqual(custom.pickedAt, point);
  });

  it('holds on a large-coordinate scene, where the relative term takes over', () => {
    const far: Vec3 = [2_345.678, 412.25, -1_876.5];
    const { normal, vertices } = roofFace(far);
    const custom = commitPick(normal, vertices[1], { min: [2_300, 400, -1_900], max: [2_400, 430, -1_850] });
    const inset = dot(vertices[1], custom.normal as Vec3) - custom.distance;
    assert.ok(inset > FACE_PICK_MIN_INSET_M, 'coordinate magnitude widens the inset');
    for (const v of vertices) {
      assert.ok(clipValue(v, custom.normal, custom.distance, false) > 0);
    }
  });

  it('never exceeds the cap, whatever the scale', () => {
    assert.equal(facePickInset([1e9, 0, 0]), FACE_PICK_MAX_INSET_M);
    assert.equal(facePickInset([0, 0, 0], { min: [-1e12, 0, 0], max: [Infinity, 0, 0] }), FACE_PICK_MAX_INSET_M);
  });
});

/**
 * #5644: the default kept side of a face pick must not depend on which way the
 * picked face points. A box solid [0, 4]^3 is picked on each of its six faces;
 * the committed plane is evaluated with the same clip value the shader uses,
 * with the `flipped` the store hands the renderer.
 */
describe('face-picked section keeps the same side for every face orientation (#5644)', () => {
  const bounds = { min: [0, 0, 0] as Vec3, max: [4, 4, 4] as Vec3 };
  const inside: Vec3 = [2, 2, 2];
  const axes = [0, 1, 2] as const;
  const faces = axes.flatMap((axis) => [1, -1].map((sign) => ({ axis, sign })));
  const label = (axis: number, sign: number) => `${sign > 0 ? '+' : '-'}${'XYZ'[axis]}`;

  /** The four corners of the box face with outward normal `sign` along `axis`. */
  function faceCorners(axis: number, sign: number): Vec3[] {
    const [u, v] = axes.filter((a) => a !== axis);
    return [[0, 0], [4, 0], [0, 4], [4, 4]].map(([a, b]) => {
      const p: Vec3 = [0, 0, 0];
      p[axis] = sign > 0 ? 4 : 0;
      p[u] = a;
      p[v] = b;
      return p;
    });
  }

  function pickFace(axis: number, sign: number) {
    const store = create<SectionSlice>()((...a) => createSectionSlice(...a));
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = sign;
    const centre: Vec3 = [2, 2, 2];
    centre[axis] = sign > 0 ? 4 : 0;
    store.getState().setSectionPickMode(true);
    store.getState().setSectionPlaneFromFace(normal, centre, bounds);
    const plane = store.getState().sectionPlane;
    assert.ok(plane.custom, 'the pick committed a custom plane');
    const outside: Vec3 = [centre[0] + normal[0], centre[1] + normal[1], centre[2] + normal[2]];
    return { store, plane, custom: plane.custom, outside, faceAt: centre[axis] };
  }

  for (const { axis, sign } of faces) {
    it(`${label(axis, sign)} face: default cuts the face away, Flip keeps it`, () => {
      const { store, plane, custom, outside } = pickFace(axis, sign);
      const clip = (p: Vec3, flipped: boolean) => clipValue(p, custom.normal, custom.distance, flipped);
      for (const v of faceCorners(axis, sign)) {
        assert.ok(clip(v, plane.flipped) > 0, `picked face vertex ${v} must be clipped by default`);
      }
      assert.ok(clip(inside, plane.flipped) < 0, 'the solid behind the face is kept, so the cap shows its cross-section');
      assert.ok(clip(outside, plane.flipped) > 0, 'the camera side of the face is removed');

      store.getState().flipSectionPlane();
      const flipped = store.getState().sectionPlane.flipped;
      for (const v of faceCorners(axis, sign)) {
        assert.ok(clip(v, flipped) < 0, `flipped, picked face vertex ${v} is kept`);
      }
      assert.ok(clip(inside, flipped) > 0, 'flipped, the solid behind the face is removed');
    });

    it(`${label(axis, sign)} face: the cardinal approximation keeps the side the custom plane keeps`, () => {
      const { store, custom, outside, faceAt } = pickFace(axis, sign);
      for (const flip of [false, true]) {
        if (flip) store.getState().flipSectionPlane();
        const plane = store.getState().sectionPlane;
        assert.equal(plane.axis, (['side', 'down', 'front'] as const)[axis]);
        // Cardinal renderer path: +axis unit normal at the face, flip relative to it.
        const cardinalNormal: Vec3 = [0, 0, 0];
        cardinalNormal[axis] = 1;
        const cardinalFlip = cardinalSectionFlipped(plane);
        for (const probe of [inside, outside]) {
          const customKept = clipValue(probe, custom.normal, custom.distance, plane.flipped) < 0;
          const cardinalKept = clipValue(probe, cardinalNormal, faceAt, cardinalFlip) < 0;
          assert.equal(cardinalKept, customKept, `probe ${probe}, flipped=${flip}`);
        }
      }
    });
  }
});
