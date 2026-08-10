/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { enuToViewerDirection, sunLightingForAltitude } from './solar-direction.js';
import { viewerToEnuRotation } from './viewer-enu-rotation.js';

function assertVecClose(actual: number[], expected: number[], eps = 1e-9) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < eps,
      `component ${i}: ${actual[i]} !≈ ${expected[i]}`,
    );
  }
}

describe('enuToViewerDirection', () => {
  it('maps the cardinal frame with no rotation: east→+X, up→+Y, north→−Z', () => {
    assertVecClose(enuToViewerDirection({ e: 1, n: 0, u: 0 }), [1, 0, 0]);
    assertVecClose(enuToViewerDirection({ e: 0, n: 0, u: 1 }), [0, 1, 0]);
    assertVecClose(enuToViewerDirection({ e: 0, n: 1, u: 0 }), [0, 0, -1]);
  });

  it('is the inverse of the cesium-bridge viewer→ENU matrix for a rotated site', () => {
    // 30° Helmert rotation, deliberately unnormalized (scaled ×2) the way
    // IFC files sometimes author the direction cosines.
    const absc = 2 * Math.cos(Math.PI / 6);
    const ordi = 2 * Math.sin(Math.PI / 6);
    const a = Math.cos(Math.PI / 6);
    const o = Math.sin(Math.PI / 6);

    const enu = { e: 0.3, n: 0.8, u: 0.52 };
    const [vx, vy, vz] = enuToViewerDirection(enu, absc, ordi);

    // Forward map from cesium-bridge.ts (unit-scale): east = a·vx + o·vz,
    // north = o·vx − a·vz, up = vy. Round-tripping must recover the input.
    const norm = Math.hypot(enu.e, enu.n, enu.u);
    assert.ok(Math.abs((a * vx + o * vz) - enu.e / norm) < 1e-9, 'east');
    assert.ok(Math.abs((o * vx - a * vz) - enu.n / norm) < 1e-9, 'north');
    assert.ok(Math.abs(vy - enu.u / norm) < 1e-9, 'up');
  });

  it('returns a unit vector', () => {
    const v = enuToViewerDirection({ e: 3, n: 4, u: 5 }, 0.6, -0.8);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  });

  it('is the EXACT inverse of the full viewer-to-ENU rotation, including gamma (#1408)', () => {
    const absc = 2 * Math.cos(Math.PI / 6); // 30deg Helmert, unnormalized x2
    const ordi = 2 * Math.sin(Math.PI / 6);
    const gamma = 0.135; // ~7.7deg meridian convergence

    // viewer dir -> ENU (bridge rotation, with gamma) -> back to viewer == identity.
    const rot = viewerToEnuRotation(1, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), gamma);
    const n0 = Math.hypot(0.3, 0.2, -0.9);
    const v = [0.3 / n0, 0.2 / n0, -0.9 / n0];
    const enu = {
      e: rot.eastFromVx * v[0] + rot.eastFromVz * v[2],
      n: rot.northFromVx * v[0] + rot.northFromVz * v[2],
      u: v[1],
    };
    assertVecClose(enuToViewerDirection(enu, absc, ordi, gamma), v);
  });

  it('omitting gamma equals gamma=0 (backward compatible default)', () => {
    const enu = { e: 0.3, n: 0.8, u: 0.52 };
    assertVecClose(enuToViewerDirection(enu, 0.6, 0.8), enuToViewerDirection(enu, 0.6, 0.8, 0));
  });

  it('gamma rotates the sun by the convergence vs the grid-only mapping', () => {
    const gamma = 0.135;
    const enu = { e: 0.5, n: 0.5, u: Math.SQRT1_2 }; // e,n > 0 so no atan2 wrap
    const grid = enuToViewerDirection(enu, 1, 0, 0);
    const withGamma = enuToViewerDirection(enu, 1, 0, gamma);
    // Horizontal bearing from grid north (viewer -Z), +east = atan2(vx, -vz).
    const bearing = (w: number[]) => Math.atan2(w[0], -w[2]);
    assert.ok(Math.abs((bearing(withGamma) - bearing(grid)) - gamma) < 1e-9,
      `expected the sun bearing to shift by exactly gamma (${gamma})`);
  });
});

/**
 * #2495 — the producer of the NaN sun direction #2494 had to reject at the
 * consumer. `Math.hypot(absc, ordi) || 1` asks about the pair's LENGTH; the
 * only question that matters is whether it carries a DIRECTION. `Infinity` is
 * truthy and `Infinity / Infinity` is NaN, so a non-finite XAxisAbscissa
 * produced `[NaN, u, NaN]` and handed it to `RenderOptions.environment`; the
 * all-zero pair took the `|| 1` branch and produced a *zero* rotation rather
 * than the identity, collapsing the sun to the zenith at every hour.
 *
 * The reference direction below is the one every rejected input must fall back
 * to: IFC's documented "no rotation" pair (1, 0), which is also this
 * function's own declared default.
 */
describe('enuToViewerDirection — non-finite and directionless inputs (#2495)', () => {
  const enu = { e: 0.5, n: 0.5, u: 0.7071067811865476 };
  const identityMapped = enuToViewerDirection(enu, 1, 0, 0);

  for (const [label, absc, ordi] of [
    ['XAxisAbscissa = Infinity', Infinity, 0],
    ['XAxisAbscissa = -Infinity', -Infinity, 0],
    ['XAxisOrdinate = Infinity', 1, Infinity],
    ['XAxisAbscissa = NaN', NaN, 0],
    ['XAxisOrdinate = NaN', 1, NaN],
    ['both non-finite', Infinity, Infinity],
    ['the all-zero pair (no direction at all)', 0, 0],
  ] as Array<[string, number, number]>) {
    it(`degrades to the IFC identity pair for ${label}`, () => {
      const v = enuToViewerDirection(enu, absc, ordi, 0);
      assert.ok(v.every(Number.isFinite), `expected a finite direction, got ${JSON.stringify(v)}`);
      assertVecClose(v, identityMapped);
    });
  }

  it('degrades a non-finite meridian convergence to no convergence', () => {
    for (const bad of [Infinity, -Infinity, NaN]) {
      const v = enuToViewerDirection(enu, 1, 0, bad);
      assert.ok(v.every(Number.isFinite), `gamma=${bad} produced ${JSON.stringify(v)}`);
      assertVecClose(v, identityMapped);
    }
  });

  it('returns the zenith rather than NaN when the ENU input itself has no direction', () => {
    assert.deepStrictEqual(enuToViewerDirection({ e: 0, n: 0, u: 0 }, 1, 0, 0), [0, 1, 0]);
    assert.deepStrictEqual(enuToViewerDirection({ e: NaN, n: 0, u: 1 }, 1, 0, 0), [0, 1, 0]);
    assert.deepStrictEqual(enuToViewerDirection({ e: Infinity, n: 0, u: 1 }, 1, 0, 0), [0, 1, 0]);
  });

  // Anti-mutation: the guards must test finiteness, not magnitude. A floor
  // (`len > 1e-6`, `vlen > 1e-6`) would pass every case above and still be
  // wrong — it would throw away legitimately tiny direction cosines, which IFC
  // permits because the pair is only ever read as a direction.
  it('still uses a legitimately tiny but perfectly valid direction pair', () => {
    const tiny = enuToViewerDirection(enu, 3e-300, 4e-300, 0);
    const same = enuToViewerDirection(enu, 0.6, 0.8, 0);
    assertVecClose(tiny, same);
    assert.notDeepStrictEqual(tiny, identityMapped);
  });

  it('still normalizes a legitimately tiny but perfectly valid ENU direction', () => {
    const v = enuToViewerDirection({ e: 1e-300, n: 0, u: 0 }, 1, 0, 0);
    assertVecClose(v, [1, 0, 0]);
  });
});

describe('sunLightingForAltitude', () => {
  it('full sun at midday, none at night', () => {
    assert.ok(sunLightingForAltitude(45).intensityFactor > 0.99);
    assert.strictEqual(sunLightingForAltitude(-20).intensityFactor, 0);
  });

  it('warms toward the horizon', () => {
    const noon = sunLightingForAltitude(60);
    const sunset = sunLightingForAltitude(1);
    assert.ok(sunset.color[2] < noon.color[2], 'blue drops near horizon');
    assert.ok(sunset.color[1] < noon.color[1], 'green drops near horizon');
  });

  it('ambient fades through twilight to a night floor', () => {
    assert.ok(sunLightingForAltitude(30).ambientFactor > 0.99);
    const night = sunLightingForAltitude(-30).ambientFactor;
    assert.ok(night > 0.1 && night < 0.25, `night floor, got ${night}`);
    const dusk = sunLightingForAltitude(-5).ambientFactor;
    assert.ok(dusk > night && dusk < 1, `twilight between floors, got ${dusk}`);
  });
});
