/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every fixture here is deliberately ASYMMETRIC - no 45 degree angles, no
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
    // instead it would read 36.87 or 53.13 - both distinguishable.
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
    // The apex makes the answer directed - folding to [0,90] would answer a
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

  it('refuses a ray shorter than one pick resolution', () => {
    // The exactly-coincident case is caught by `normalize` returning null, so
    // it does NOT pin the threshold - with the guard removed, every other
    // test in this file still passed.
    //
    // The threshold is the SNAP FLOOR (1/65536 m = 15.3 um), not an arbitrary
    // epsilon. An earlier version used 1e-9 m, which is 15,259x below the
    // floor: nothing reachable could land in (0, 1e-9], so it classified
    // nothing. Below one pick resolution a ray's direction is cursor noise.
    const apex = { x: 0, y: 0, z: 0 };
    const far = { x: 0, y: 0, z: 3 };
    assert.equal(threePointAngle(apex, { x: 1e-6, y: 0, z: 0 }, far).kind, 'degenerate');
  });

  it('pins the degenerate threshold to the snap floor from both sides', () => {
    const apex = { x: 0, y: 0, z: 0 };
    const far = { x: 0, y: 0, z: 3 };
    const floor = 1 / 65536;
    assert.equal(threePointAngle(apex, { x: floor * 0.9, y: 0, z: 0 }, far).kind, 'degenerate');
    assert.equal(threePointAngle(apex, { x: floor * 1.1, y: 0, z: 0 }, far).kind, 'angled');
  });

  it('keeps the mirrored snap floor in step with the renderer\'s own constant', () => {
    // `three-point-angle.ts` mirrors `MIN_SNAP_TOLERANCE` from
    // `packages/renderer/src/snap-weld.ts` rather than importing it (this
    // module has no renderer dependency). If the renderer's floor moves and
    // this does not, the thresholds above silently stop matching pick
    // resolution - so the value is pinned here explicitly.
    assert.equal(1 / 65536, 0.0000152587890625);
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
    // and passed under BOTH implementations - it asserted a property it could
    // not observe. This one was found by search and verified to NaN.
    const v = { x: 0.010309278033673763, y: 0.02247191034257412, z: 0.022900763899087906 };
    const apex = { x: 0, y: 0, z: 0 };
    const a = { x: v.x, y: v.y, z: v.z };
    const b = { x: v.x * 2, y: v.y * 2, z: v.z * 2 };
    const r = threePointAngle(apex, a, b);
    assert.ok(Number.isFinite(r.degrees), `expected a finite angle, got ${r.degrees}`);
    assert.equal(r.kind, 'zero');
  });

  it('judges collinearity by PERPENDICULAR OFFSET, so it scales with ray length', () => {
    // snap-weld.ts:43-54 argues a fixed angle is the wrong primitive: too
    // tight for short rays far from the origin, too loose for long ones near
    // it. A 5 mm perpendicular dogleg is a REAL corner on a 0.2 m ray and is
    // still a real corner on a 200 m one - an angle band would call the
    // second one straight.
    const apex = { x: 0, y: 0, z: 0 };
    const shortRay = threePointAngle(apex, { x: 0.2, y: 0, z: 0 }, { x: -0.2, y: 0.005, z: 0 });
    const longRay = threePointAngle(apex, { x: 200, y: 0, z: 0 }, { x: -200, y: 0.005, z: 0 });
    assert.equal(shortRay.kind, 'angled', 'a 5 mm offset on a 0.2 m ray is a real corner');
    assert.equal(longRay.kind, 'angled', 'and it is still a real corner on a 200 m ray');
  });

  it('pins the collinear offset to the snap floor from both sides', () => {
    const apex = { x: 0, y: 0, z: 0 };
    const a = { x: 1, y: 0, z: 0 };
    const floor = 1 / 65536;
    // Offset is measured perpendicular to the apex->a line, so vary y.
    assert.equal(threePointAngle(apex, a, { x: -1, y: floor * 0.9, z: 0 }).kind, 'straight');
    assert.equal(threePointAngle(apex, a, { x: -1, y: floor * 1.1, z: 0 }).kind, 'angled');
  });
});

describe('formatThreePointAngle', () => {
  it('renders a degenerate pick as an em dash, never as 0.0 degrees', () => {
    assert.equal(formatThreePointAngle({ kind: 'degenerate', degrees: 0 }), '-');
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
