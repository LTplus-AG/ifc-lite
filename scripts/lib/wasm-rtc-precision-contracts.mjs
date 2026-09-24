#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

/**
 * #4934 regression: a model 1-10km from the origin used to sit inside the
 * OLD 10km RTC gate, so nothing was subtracted and every vertex was cast
 * straight to f32 -- a sub-millimetre lattice at that magnitude, enough to
 * turn flush faces into z-fighting speckle. With the gate lowered to 1km
 * such a model must now be rebased.
 *
 * Split out of `test-wasm-contract.mjs` (module-size ratchet) rather than
 * appended there, per AGENTS.md "put new code in new files".
 *
 * @param api the loaded wasm API.
 * @param test the shared test() runner from test-wasm-contract.mjs.
 * @param columnContent the base column fixture content.
 * @param withSiteOriginMetres transplants the fixture's site origin (metres).
 * @param columnLocalXM the column's local-placement X offset (metres).
 * @param columnLocalYM the column's local-placement Y offset (metres).
 */
export function runRtcPrecisionContracts(
  api,
  test,
  columnContent,
  withSiteOriginMetres,
  columnLocalXM,
  columnLocalYM,
) {
  test('#4934: a 1-10km survey-grid plant now gets an RTC anchor and sub-mm precision', () => {
    // The reported bug: a site laid out on a survey grid (here ~(6300, 7700) m,
    // matching the issue's ~6.3km/7.7km ArchiCAD export) sat inside the OLD
    // 10km gate, so nothing was subtracted and every vertex was cast straight
    // to f32 — a ~0.26mm lattice at that magnitude, enough to turn flush faces
    // into z-fighting speckle. With the gate at 1km this plant must now be
    // rebased.
    const PLANT_X_M = 6_300;
    const PLANT_Y_M = 7_700;
    const moved = withSiteOriginMetres(PLANT_X_M, PLANT_Y_M);
    assert.notEqual(moved, columnContent, 'Placement transplant must change the content');

    const collection = parseMeshesViaPrePass(api, moved);

    assert.equal(collection.hasRtcOffset(), true, 'needsShift must be true for a 1-10km plant');
    assert.ok(
      Math.abs(collection.rtcOffsetX - (PLANT_X_M + columnLocalXM)) < 1000,
      `rtcOffsetX ${collection.rtcOffsetX} should be within 1km of ${PLANT_X_M}`,
    );
    assert.ok(
      Math.abs(collection.rtcOffsetY - (PLANT_Y_M + columnLocalYM)) < 1000,
      `rtcOffsetY ${collection.rtcOffsetY} should be within 1km of ${PLANT_Y_M}`,
    );

    // Every emitted mesh's world position (origin + position, both f64 before
    // the f32 store) must land within 100 m of the render origin, and the f32
    // ULP at that magnitude must stay well under a tenth of a millimetre —
    // the precision guarantee the threshold change exists to restore.
    assert.ok(collection.length > 0, 'Moved column should still mesh');
    let maxAbs = 0;
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      const o = mesh.origin;
      for (let j = 0; j < mesh.positions.length; j++) {
        const world = mesh.positions[j] + (o ? o[j % 3] : 0);
        maxAbs = Math.max(maxAbs, Math.abs(world));
      }
      mesh.free();
    }
    assert.ok(maxAbs < 100, `rebased positions must stay building-scale, got max |position| = ${maxAbs}`);
    assert.ok(
      Math.abs(Math.fround(maxAbs) - maxAbs) < 1e-5,
      `f32 round-trip of the largest rebased position must lose under 1e-5 m, got ${Math.abs(Math.fround(maxAbs) - maxAbs)}`,
    );

    collection.free();
  });

  test('#5749: LV95 site plus kilometre-local vertices preserves thin geometry through WASM', () => {
    // The public column fixture declares inch geometry via a 0.0254 m unit.
    const inchToMetres = 0.0254;
    const site = [2_600_000, 1_200_000];
    const localMetres = [3_500, 2_300, 1_190];
    const localOffset = localMetres.map(metres => metres / inchToMetres);
    const sitePlaced = withSiteOriginMetres(...site);
    const placement = /#125\s*=\s*IFCCARTESIANPOINT\(\([^)]*\)\);/;
    assert.match(sitePlaced, placement, 'public column fixture has a local placement');
    const zeroPlacement = sitePlaced.replace(placement, '#125= IFCCARTESIANPOINT((0.,0.,0.));');
    const pointList = /#287\s*=\s*IFCCARTESIANPOINTLIST3D\(\((.*)\)\);/;
    assert.match(zeroPlacement, pointList, 'public column fixture has tessellated vertices');
    let shiftedVertices = 0;
    const shifted = zeroPlacement.replace(pointList, (_match, points) => {
      const tuples = points.replace(/\((-?\d+(?:\.\d*)?),(-?\d+(?:\.\d*)?),(-?\d+(?:\.\d*)?)\)/g,
        (_tuple, x, y, z) => {
          shiftedVertices++;
          return `(${[x, y, z].map((value, axis) => (Number(value) + localOffset[axis]).toFixed(6)).join(',')})`;
        });
      return `#287= IFCCARTESIANPOINTLIST3D((${tuples}));`;
    });
    assert.equal(shiftedVertices, 24, 'the transform must move every authored vertex');

    const collection = parseMeshesViaPrePass(api, shifted);
    try {
      assert.equal(collection.hasRtcOffset(), true, 'the real pre-pass must detect the LV95 frame');
      assert.ok(Math.abs(collection.rtcOffsetX - site[0]) < 1);
      assert.ok(Math.abs(collection.rtcOffsetY - site[1]) < 1);
      assert.equal(collection.length, 1);
      assert.equal(collection.totalTriangles, 12, 'the thin column must keep all six faces');

      const mesh = collection.get(0);
      try {
        const positions = mesh.positions;
        const origin = mesh.origin;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) {
          for (let axis = 0; axis < 3; axis++) {
            const world = positions[i + axis] + origin[axis];
            min[axis] = Math.min(min[axis], world);
            max[axis] = Math.max(max[axis], world);
          }
        }
        // IFC Z-up becomes viewer Y-up, and IFC Y becomes negative viewer Z.
        // Pin absolute bounds as well as dimensions: a coherent but displaced
        // column would otherwise satisfy an extent-only regression test.
        const expectedMin = [localMetres[0] - 4 * inchToMetres, localMetres[2], -localMetres[1] - 4 * inchToMetres];
        const expectedMax = [localMetres[0] + 4 * inchToMetres, localMetres[2] + 120 * inchToMetres, -localMetres[1] + 4 * inchToMetres];
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(Math.abs(min[axis] - expectedMin[axis]) < 0.001,
            `axis ${axis}: emitted min ${min[axis]}m, authored ${expectedMin[axis]}m`);
          assert.ok(Math.abs(max[axis] - expectedMax[axis]) < 0.001,
            `axis ${axis}: emitted max ${max[axis]}m, authored ${expectedMax[axis]}m`);
        }
      } finally {
        mesh.free();
      }
    } finally {
      collection.free();
    }
  });
}
