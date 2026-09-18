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
}
