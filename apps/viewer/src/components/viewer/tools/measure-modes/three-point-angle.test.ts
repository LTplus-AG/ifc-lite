/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every fixture here is deliberately ASYMMETRIC — no 45 degree angles, no
 * equilateral triangles, no unit-length rays.
 *
 * A symmetric fixture passes under argument swaps, folds and inversions, so it
 * cannot tell a correct implementation from several wrong ones. The 3-4-5
 * triangle is used because its three interior angles (36.87 / 53.13 / 90) are
 * mutually distinct, so measuring at the wrong vertex changes the number.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatThreePointAngle, threePointAngle } from './three-point-angle';

/** Right triangle, legs 3 and 4 on the XZ plane. Angles: 36.87 / 53.13 / 90. */
const APEX_3_4_5 = { x: 0, y: 0, z: 0 };
const LEG_4 = { x: 4, y: 0, z: 0 };
const LEG_3 = { x: 0, y: 0, z: 3 };

describe('threePointAngle', () => {
  it('measures at the APEX, not at either ray end', () => {
    // Apex at the right angle: 90. If the implementation measured at a ray end
    // instead it would read 36.87 or 53.13 — both distinguishable.
    const r = threePointAngle(APEX_3_4_5, LEG_4, LEG_3);
    assert.equal(r.kind, 'angled');
    assert.ok(Math.abs(r.degrees - 90) < 1e-9, `expected 90, got ${r.degrees}`);
  });

  it('reads the acute vertex of the same triangle as 36.87, not its complement', () => {
    // Apex moved to the end of the long leg. atan(3/4) = 36.8699...
    const r = threePointAngle(LEG_4, APEX_3_4_5, LEG_3);
    assert.equal(r.kind, 'angled');
    assert.ok(Math.abs(r.degrees - 36.8698976) < 1e-5, `expected 36.87, got ${r.degrees}`);
  });

  it('reports an obtuse angle unfolded: 120, not its 60 supplement', () => {
    // The apex makes the answer directed — folding to [0,90] would answer a
    // question the user did not ask.
    const apex = { x: 0, y: 0, z: 0 };
    const a = { x: 1, y: 0, z: 0 };
    const b = { x: Math.cos((120 * Math.PI) / 180), y: 0, z: Math.sin((120 * Math.PI) / 180) };
    const r = threePointAngle(apex, a, b);
    assert.equal(r.kind, 'angled');
    assert.ok(Math.abs(r.degrees - 120) < 1e-6, `expected 120, got ${r.degrees}`);
  });

  it('is scale invariant: ray length does not change the angle', () => {
    const near = threePointAngle(APEX_3_4_5, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 3 });
    const far = threePointAngle(APEX_3_4_5, { x: 4000, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 });
    assert.ok(Math.abs(near.degrees - far.degrees) < 1e-9);
  });

  it('is symmetric in the two ray picks', () => {
    const ab = threePointAngle(APEX_3_4_5, LEG_4, LEG_3);
    const ba = threePointAngle(APEX_3_4_5, LEG_3, LEG_4);
    assert.equal(ab.kind, ba.kind);
    assert.ok(Math.abs(ab.degrees - ba.degrees) < 1e-12);
  });

  it('classifies a zero-length ray as degenerate, not as a real 0 degrees', () => {
    // The discriminator that stops a formatter rendering "nothing measured"
    // and "a real zero angle" identically.
    const r = threePointAngle(APEX_3_4_5, APEX_3_4_5, LEG_3);
    assert.equal(r.kind, 'degenerate');
  });

  it('treats a sub-nanometre ray as degenerate, not as a measurable direction', () => {
    // The exactly-coincident case above is caught by `normalize` returning
    // null, so it does NOT pin the metre threshold — with the threshold
    // deleted, every other test in this file still passed. Two picks that
    // snapped to "the same" vertex differ by f32 noise rather than by zero,
    // so the threshold is the thing that makes them degenerate.
    const apex = { x: 0, y: 0, z: 0 };
    const nearlyApex = { x: 1e-12, y: 0, z: 0 };
    assert.equal(threePointAngle(apex, nearlyApex, { x: 0, y: 0, z: 3 }).kind, 'degenerate');
  });

  it('pins the degenerate length threshold from both sides', () => {
    // Just below the default 1e-9 m is degenerate; just above is a real ray.
    const apex = { x: 0, y: 0, z: 0 };
    const far = { x: 0, y: 0, z: 3 };
    assert.equal(threePointAngle(apex, { x: 9e-10, y: 0, z: 0 }, far).kind, 'degenerate');
    assert.equal(threePointAngle(apex, { x: 2e-9, y: 0, z: 0 }, far).kind, 'angled');
  });

  it('classifies same-direction rays as a real zero, not as degenerate', () => {
    const r = threePointAngle(APEX_3_4_5, { x: 1, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
    assert.equal(r.kind, 'zero');
    assert.equal(r.degrees, 0);
  });

  it('classifies opposite rays as straight and reports exactly 180', () => {
    // Reachable, not pathological: three picks along one reconstructed edge run
    // put the apex on an interior junction between the other two.
    const r = threePointAngle(APEX_3_4_5, { x: -2, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    assert.equal(r.kind, 'straight');
    assert.equal(r.degrees, 180);
  });

  it('returns a finite angle where acos(dot) would NaN', () => {
    // NOT a hypothetical. Normalising an f32-derived vector leaves its own
    // self-dot ABOVE 1 (x/n rounds per component), and acos NaNs outside
    // [-1, 1]. This exact vector is reproducible: its normalised self-dot is
    // 1.0000000000000002, so an acos implementation returns NaN for two rays
    // pointing along it. atan2(|cross|, dot) has no domain restriction.
    //
    // My first version of this test used two hand-written near-opposite rays
    // and passed under BOTH implementations — it asserted a property it could
    // not observe. This one was found by search and verified to NaN.
    const v = { x: 0.010309278033673763, y: 0.02247191034257412, z: 0.022900763899087906 };
    const apex = { x: 0, y: 0, z: 0 };
    const a = { x: v.x, y: v.y, z: v.z };
    const b = { x: v.x * 2, y: v.y * 2, z: v.z * 2 };
    const r = threePointAngle(apex, a, b);
    assert.ok(Number.isFinite(r.degrees), `expected a finite angle, got ${r.degrees}`);
    assert.equal(r.kind, 'zero');
  });

  it('pins the collinear tolerance from both sides', () => {
    // Just inside the band classifies as straight; just outside stays angled.
    const apex = { x: 0, y: 0, z: 0 };
    const a = { x: 1, y: 0, z: 0 };
    const inside = (179.995 * Math.PI) / 180;
    const outside = (179.98 * Math.PI) / 180;
    assert.equal(
      threePointAngle(apex, a, { x: Math.cos(inside), y: Math.sin(inside), z: 0 }).kind,
      'straight',
    );
    assert.equal(
      threePointAngle(apex, a, { x: Math.cos(outside), y: Math.sin(outside), z: 0 }).kind,
      'angled',
    );
  });
});

describe('formatThreePointAngle', () => {
  it('renders a degenerate pick as an em dash, never as 0.0 degrees', () => {
    assert.equal(formatThreePointAngle({ kind: 'degenerate', degrees: 0 }), '—');
  });

  it('distinguishes a real zero from a degenerate one', () => {
    assert.equal(formatThreePointAngle({ kind: 'zero', degrees: 0 }), '0.0°');
  });

  it('labels a straight angle rather than printing a bare 180', () => {
    assert.equal(formatThreePointAngle({ kind: 'straight', degrees: 180 }), '180.0°  straight');
  });

  it('renders a measured angle to one decimal', () => {
    assert.equal(formatThreePointAngle({ kind: 'angled', degrees: 36.8698976 }), '36.9°');
  });
});
