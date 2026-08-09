/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { viewBasis } from '@ifc-lite/renderer';

import { ecefCameraFrame } from './ecef-camera-frame.js';
import { viewerToEnuRotation } from './viewer-enu-rotation.js';

/**
 * #2495 — the ECEF camera frame `cesium-bridge.syncCamera` writes into
 * `viewer.camera` every animation frame.
 *
 * The floor it replaced (`dirLen < 1e-8`) is the family #2489 / #2494 closed
 * inside `packages/renderer`: `Infinity < 1e-8` is false and `NaN < 1e-8` is
 * false, so both slipped past the bail-out that exists precisely to stop a
 * meaningless direction, and the division that followed wrote NaN into the
 * Cesium camera.
 */

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const v = (x: number, y: number, z: number) => ({ x, y, z });

/** Component-wise closeness — `deepStrictEqual` would separate `-0` from `0`,
 *  which a cross product produces freely and which no consumer can observe. */
function assertVecClose(actual: readonly number[], expected: readonly number[], msg?: string) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-12,
      `${msg ?? 'vector'} component ${i}: ${actual[i]} !≈ ${expected[i]}`,
    );
  }
}

function assertOrthonormal(frame: NonNullable<ReturnType<typeof ecefCameraFrame>>) {
  for (const [name, axis] of Object.entries(frame)) {
    assert.ok(axis.every(Number.isFinite), `${name} is not finite: ${JSON.stringify(axis)}`);
    assert.ok(Math.abs(len(axis) - 1) < 1e-12, `${name} is not unit length: ${len(axis)}`);
  }
  assert.ok(Math.abs(dot(frame.direction, frame.up)) < 1e-12, 'direction ⟂ up');
  assert.ok(Math.abs(dot(frame.direction, frame.right)) < 1e-12, 'direction ⟂ right');
  assert.ok(Math.abs(dot(frame.up, frame.right)) < 1e-12, 'up ⟂ right');
}

describe('ecefCameraFrame — ordinary poses', () => {
  it('derives the right-handed frame from an ordinary pose', () => {
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0, 0, 1))!;
    assert.ok(frame);
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [1, 0, 0]);
    assertVecClose(frame.up, [0, 0, 1]);
    assertVecClose(frame.right, [0, -1, 0]);
  });

  it('re-orthogonalises an up that is only approximately perpendicular', () => {
    // Real ECEF poses arrive with an up a few ulps off perpendicular; Cesium
    // rejects a non-orthogonal frame outright.
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0.2, 0, 1))!;
    assertOrthonormal(frame);
    assert.ok(frame.up[2] > 0.99, 'kept the requested up hemisphere');
  });

  it('handles genuine ECEF magnitudes (≈6.4e6 m) without any upper bound kicking in', () => {
    const frame = ecefCameraFrame(
      v(4_517_590.9, 837_996.4, 4_442_954.4),
      v(4_517_600.9, 838_006.4, 4_442_964.4),
      v(0.7, 0.13, 0.7),
    )!;
    assert.ok(frame, 'a real-world ECEF pose must survive');
    assertOrthonormal(frame);
  });
});

describe('ecefCameraFrame — non-finite and degenerate poses (#2495)', () => {
  it('rejects target ≡ position (the case the original floor was written for)', () => {
    assert.strictEqual(ecefCameraFrame(v(1, 2, 3), v(1, 2, 3), v(0, 0, 1)), null);
    assert.strictEqual(ecefCameraFrame(v(0, 0, 0), v(1e-12, 0, 0), v(0, 0, 1)), null);
  });

  for (const [label, pos, target] of [
    ['an infinite eye coordinate', v(Infinity, 0, 0), v(10, 0, 0)],
    ['an infinite target coordinate', v(0, 0, 0), v(Infinity, 0, 0)],
    ['both infinite (Infinity − Infinity = NaN)', v(Infinity, 0, 0), v(Infinity, 0, 0)],
    ['a NaN eye coordinate', v(NaN, 0, 0), v(10, 0, 0)],
    ['a NaN target coordinate', v(0, 0, 0), v(0, NaN, 0)],
  ] as Array<[string, { x: number; y: number; z: number }, { x: number; y: number; z: number }]>) {
    it(`rejects ${label} instead of writing NaN into the camera`, () => {
      assert.strictEqual(ecefCameraFrame(pos, target, v(0, 0, 1)), null);
    });
  }

  it('substitutes a basis when up is parallel to the view direction (the plan view)', () => {
    // The finite degeneracy no finiteness guard would ever catch: looking
    // straight down world Z with up still world Z makes `direction × up` the
    // zero vector, and normalising that is NaN.
    const frame = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    assert.ok(frame, 'a plan view must still produce a frame');
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [0, 0, -1]);
  });

  it('substitutes a basis for a non-finite or zero up, keeping the real direction', () => {
    for (const bad of [v(Infinity, 0, 0), v(NaN, 0, 0), v(0, 0, 0)]) {
      const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), bad)!;
      assert.ok(frame, `up=${JSON.stringify(bad)} must not lose the frame`);
      assertOrthonormal(frame);
      assertVecClose(frame.direction, [1, 0, 0], 'the usable direction is preserved');
    }
  });

  it('is deterministic: the same substituted pose gives a bit-identical frame', () => {
    // The frame is rewritten every animation frame; a substitute that varied
    // would spin the basemap while the user held still.
    const a = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    const b = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    assert.deepStrictEqual(a, b);
  });

  // Anti-mutation. The direction bail-out must stay a finiteness test plus the
  // 1e-8 floor it always had — widening the floor would silently drop
  // legitimate close-focus poses, which is exactly the failure mode a
  // magnitude-only reading of this guard produces.
  it('still accepts a short but perfectly valid view direction', () => {
    const frame = ecefCameraFrame(v(0, 0, 0), v(1e-6, 0, 0), v(0, 0, 1))!;
    assert.ok(frame, 'a 1µm view vector is short, not degenerate');
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [1, 0, 0]);
  });

  it('still accepts a tiny but perfectly valid up vector', () => {
    // World Y, deliberately NOT the axis the substitute would pick for this
    // direction (that is world Z) — otherwise a floor that wrongly rejected
    // the tiny up would land on the same answer by coincidence and the test
    // could not fail.
    //
    // 1e-300 is also below the point where |up|² underflows to zero, so this
    // pins the angular test to the NORMALISED up: the same threshold written
    // against the squared length, as `viewBasis` states it, would read this
    // legitimate input as degenerate.
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0, 1e-300, 0))!;
    assert.ok(frame);
    assertOrthonormal(frame);
    assertVecClose(frame.up, [0, 1, 0], 'a tiny up still names the up hemisphere');
  });
});

// ---------------------------------------------------------------------------
// A real ENU→ECEF frame, so the poses below are the ones Cesium actually syncs
// rather than unit-scale stand-ins. `cesium-bridge.syncCamera` maps a
// viewer-space point through `viewerToEcefMatrix` (rotation + translation) and
// a viewer-space vector through its rotation alone; these two do the same.
// ---------------------------------------------------------------------------

const WGS84_A = 6378137.0;
const WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);

/** Zurich HB — a real project anchor, ~6.4e6 m from the geocentre. */
const SITE = { lat: 47.3779, lon: 8.5403, height: 408 };

/** The grid alignment + meridian convergence a georeferenced model carries.
 *  Non-zero on purpose: it is the whole difference between "the renderer's
 *  substitute rotated into ECEF" and "an ECEF-global axis". */
const ROT = viewerToEnuRotation(1, 1, 0, 0.35);

const LAT = (SITE.lat * Math.PI) / 180;
const LON = (SITE.lon * Math.PI) / 180;
const SL = Math.sin(LAT), CL = Math.cos(LAT), SO = Math.sin(LON), CO = Math.cos(LON);
const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * SL * SL);
/** Columns of the ENU→ECEF rotation at the site: east, north, up. */
const EAST = [-SO, CO, 0] as const;
const NORTH = [-SL * CO, -SL * SO, CL] as const;
const UP = [CL * CO, CL * SO, SL] as const;
const ORIGIN = [
  (N + SITE.height) * CL * CO,
  (N + SITE.height) * CL * SO,
  (N * (1 - WGS84_E2) + SITE.height) * SL,
] as const;

/**
 * `viewerToEcefMatrix` applied as a VECTOR (rotation only) — the same
 * composition `cesium-bridge.ensureEcefCache` builds: viewer→ENU through
 * {@link viewerToEnuRotation} (viewer Y IS ENU up; X and Z carry the grid
 * rotation), then ENU→ECEF at the site.
 */
const toEcefVector = (x: number, y: number, z: number) => {
  const e = ROT.eastFromVx * x + ROT.eastFromVz * z;
  const n = ROT.northFromVx * x + ROT.northFromVz * z;
  const u = y;
  return {
    x: EAST[0] * e + NORTH[0] * n + UP[0] * u,
    y: EAST[1] * e + NORTH[1] * n + UP[1] * u,
    z: EAST[2] * e + NORTH[2] * n + UP[2] * u,
  };
};

/** ...and as a POINT (rotation + translation). */
const toEcefPoint = (x: number, y: number, z: number) => {
  const r = toEcefVector(x, y, z);
  return { x: r.x + ORIGIN[0], y: r.y + ORIGIN[1], z: r.z + ORIGIN[2] };
};

const angleBetween = (a: readonly number[], b: readonly number[]) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

describe('ecefCameraFrame — nearly parallel axes are degenerate, not usable', () => {
  it('an EXACT overhead pose is residue, not a direction', () => {
    // The reproduction, stated as the thing a finiteness screen plus a
    // `!== 0` floor cannot see. `posECEF` and `targetECEF` are two ~6.4e6 m
    // points, so subtracting them for a pose whose up is EXACTLY antiparallel
    // to the view direction does not cancel to zero: it leaves ~1e-13 of
    // rounding, which is finite and nonzero and therefore normalisable.
    const pos = toEcefPoint(0, 200, 0);
    const target = toEcefPoint(0, 0, 0);
    const up = toEcefVector(0, 1, 0);

    const delta = [target.x - pos.x, target.y - pos.y, target.z - pos.z];
    const dl = len(delta);
    const dir = delta.map((c) => c / dl);
    const ul = len([up.x, up.y, up.z]);
    const u = [up.x / ul, up.y / ul, up.z / ul];
    const residue = len([
      dir[1] * u[2] - dir[2] * u[1],
      dir[2] * u[0] - dir[0] * u[2],
      dir[0] * u[1] - dir[1] * u[0],
    ]);

    assert.ok(residue > 0, 'the premise: the cross product is NOT zero here');
    assert.ok(Number.isFinite(residue), 'and it is perfectly finite');
    assert.ok(residue < 1e-9, `residue should be numerical noise, got ${residue}`);
  });

  it('does not build the camera frame out of that residue', () => {
    // Before the angular threshold, `right` was that noise normalised: the
    // basemap's roll was decided by the low bits of an ECEF subtraction.
    // Millimetres of eye altitude swung it by up to 166°.
    const rights = [200, 200.001, 200.002, 200.003, 200.01, 250].map((h) => {
      const frame = ecefCameraFrame(
        toEcefPoint(0, h, 0),
        toEcefPoint(0, 0, 0),
        toEcefVector(0, 1, 0),
      )!;
      assert.ok(frame, `h=${h} must still produce a frame`);
      assertOrthonormal(frame);
      return frame.right;
    });

    for (let i = 1; i < rights.length; i++) {
      // 1e-3° is five orders below the pre-fix swing and three above the
      // residual ~1e-6° that `acos` loses to rounding for two nearly identical
      // unit vectors, so it separates the two without pinning fp noise.
      assert.ok(
        angleBetween(rights[0], rights[i]) < 1e-3,
        `right swung ${angleBetween(rights[0], rights[i]).toFixed(2)}° for a ` +
          'sub-metre eye move — the basemap spinning under a stationary user',
      );
    }
  });

  // Anti-mutation for the threshold itself. A microradian is deliberately far
  // below any pose the navigation code produces; widening it would silently
  // swap a real, usable, deliberately-near-vertical view for the substitute.
  it('still honours an up only 0.01 rad off the view direction', () => {
    // 0.01 rad is where the ViewCube's top preset stops, so this is a pose a
    // user reaches by clicking a button — not an exotic input.
    const s = Math.sin(0.01);
    const c = Math.cos(0.01);
    const frame = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(s, 0, c))!;
    assert.ok(frame);
    assertOrthonormal(frame);
    // The requested up's answer, which is 90° from the substitute's (1, 0, 0)
    // for this direction — so a threshold that wrongly rejected it cannot land
    // on the same result by coincidence.
    assertVecClose(frame.right, [0, -1, 0], 'the requested roll must survive');
    assert.ok(frame.up[0] > 0.99, 'and the up hemisphere the caller asked for');
  });

  it('still honours a legitimately near-parallel up at genuine ECEF magnitudes', () => {
    // The same claim where the cancellation actually happens: 1e-4 rad is four
    // orders above the threshold and nine above the residue measured in the
    // first test, so the two are not remotely confusable.
    const tilt = 1e-4;
    const frame = ecefCameraFrame(
      toEcefPoint(0, 200, 0),
      toEcefPoint(0, 0, 0),
      toEcefVector(Math.sin(tilt), Math.cos(tilt), 0),
    )!;
    assert.ok(frame);
    assertOrthonormal(frame);
    // `right` is the ECEF image of viewer +Z, the answer the caller's tilt
    // asks for. (The viewer→ECEF composition has determinant +1, so a cross
    // product taken in viewer space maps straight through it.)
    const expected = toEcefVector(0, 0, 1);
    assert.ok(
      angleBetween(frame.right, [expected.x, expected.y, expected.z]) < 0.01,
      'a 1e-4 rad tilt is a real roll and must be honoured',
    );
  });
});

describe('ecefCameraFrame — the substituted basis and the rendered image agree', () => {
  // The plan view where `up` is genuinely parallel to the view direction. The
  // roll is not recoverable from `(position, target, up)` at that point — an
  // up parallel to the direction has no component in the plane roll turns in —
  // so `ecefCameraFrame`'s own Earth-fixed seed is the honest last resort.
  // `cesium-bridge.syncCamera` does not have to settle for it: it still holds
  // the viewer-space pose, and resolves `up` through the renderer's `viewBasis`
  // — the very substitution the IFC image on screen was drawn with — before
  // rotating it into ECEF.
  const camPos = { x: 0, y: 200, z: 0 };
  const camTarget = { x: 0, y: 0, z: 0 };
  const camUp = { x: 0, y: 1, z: 0 }; // renderer default: Y-up, parallel to the view

  it('the renderer treats this pose as degenerate too', () => {
    // The premise. If `viewBasis` honoured this `up` there would be no
    // disagreement to fix, and the test below would pass for the wrong reason.
    const basis = viewBasis(camPos, camTarget, camUp);
    const parallel = Math.abs(
      basis.forward.x * camUp.x + basis.forward.y * camUp.y + basis.forward.z * camUp.z,
    );
    assert.ok(parallel > 1 - 1e-12, 'up really is parallel to the view direction');
    assert.ok(
      Math.abs(basis.up.y) < 1e-12,
      'so the renderer substituted its own up rather than using this one',
    );
  });

  it('routing the renderer’s resolved up through gives the image’s own axis', () => {
    // Exactly what the bridge composes: viewBasis in viewer space, rotated to
    // ECEF, into the frame builder.
    const resolved = viewBasis(camPos, camTarget, camUp).up;
    const upECEF = toEcefVector(resolved.x, resolved.y, resolved.z);
    const frame = ecefCameraFrame(
      toEcefPoint(camPos.x, camPos.y, camPos.z),
      toEcefPoint(camTarget.x, camTarget.y, camTarget.z),
      upECEF,
    )!;
    assert.ok(frame);
    assertOrthonormal(frame);
    assert.ok(
      angleBetween(frame.up, [upECEF.x, upECEF.y, upECEF.z]) < 1e-6,
      'the Cesium up must be the ECEF image of the axis the model was drawn with',
    );
  });

  it('and the raw up does NOT — it lands on an Earth-fixed axis instead', () => {
    // The disagreement being fixed, measured. Sending `camera.getUp()` raw
    // makes the helper substitute, and its seed is ECEF world Z/Y: an axis
    // with no relationship to the model's grid, so the basemap sits rotated
    // under the building.
    const resolved = viewBasis(camPos, camTarget, camUp).up;
    const resolvedECEF = toEcefVector(resolved.x, resolved.y, resolved.z);
    const rawECEF = toEcefVector(camUp.x, camUp.y, camUp.z);

    const pos = toEcefPoint(camPos.x, camPos.y, camPos.z);
    const target = toEcefPoint(camTarget.x, camTarget.y, camTarget.z);
    const fromRaw = ecefCameraFrame(pos, target, rawECEF)!;
    const fromResolved = ecefCameraFrame(pos, target, resolvedECEF)!;

    assert.ok(fromRaw && fromResolved);
    assertOrthonormal(fromRaw);
    const disagreement = angleBetween(fromRaw.up, fromResolved.up);
    assert.ok(
      disagreement > 1,
      `the two answers must genuinely differ, got ${disagreement.toFixed(3)}°`,
    );
  });
});
