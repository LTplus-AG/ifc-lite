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
