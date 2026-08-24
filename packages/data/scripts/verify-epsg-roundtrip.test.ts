/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { loadFixtures, verifyFixture } from './verify-epsg-roundtrip.js';

/**
 * Runs the curated EPSG control points as part of `pnpm test`.
 *
 * The verification itself is not new — `verify-epsg-roundtrip.ts` has always
 * done this, and does it well, reprojecting published landmark coordinates
 * (the Amersfoort tower, the Rostock control point) through the bundled proj4
 * definitions and demanding agreement within a metre. What was missing is that
 * it only ran when somebody typed `pnpm verify:epsg`, so nothing failed if
 * they didn't.
 *
 * Measured on this branch: changing EPSG:28992's `lon_0` from 5.3876 to
 * 5.2876 -- a plausible transcription slip, and about 700 metres on the
 * ground -- leaves `packages/data` at 173/173 passing and the viewer's
 * `reproject.test.ts` at 32/32. The standalone script catches it immediately
 * (`fwd=6828.75m` against a 1 m tolerance). This file is the wiring, not the
 * check.
 *
 * `epsg-index.test.ts` covers lookup and search over the same index, but
 * nothing there asks whether a definition is geodetically *correct*: a CRS can
 * be found by code and name while placing the model in the wrong country.
 *
 * The whole set runs in well under a second, so there is no reason for it to
 * be opt-in. Each fixture is its own `it` so a failure names the CRS rather
 * than reporting "17 fixtures, 1 failed".
 */

const fixtures = loadFixtures();

describe('bundled EPSG definitions place published control points correctly', () => {
  it('the fixture set is present and non-empty', () => {
    // If the JSON ever fails to resolve, every generated case below would
    // silently vanish and this file would pass by testing nothing.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`EPSG:${fixture.epsg} — ${fixture.name}`, async () => {
      const result = await verifyFixture(fixture);

      // `reason` carries the specific failure (code absent from the index, no
      // proj4 string, a transform that threw). Surface it rather than letting
      // the numeric assertion below report a bare null.
      expect(result.reason ?? null, `EPSG:${fixture.epsg} ${result.reason ?? ''}`).toBeNull();

      expect(result.forwardErrorM).not.toBeNull();
      expect(result.roundTripErrorM).not.toBeNull();

      // Forward: does the bundled definition put the published projected
      // coordinate at its published latitude and longitude? This is the check
      // that catches a wrong ellipsoid, meridian, or missing datum shift --
      // the errors that land a model in the wrong place with no complaint.
      expect(
        result.forwardErrorM!,
        `EPSG:${fixture.epsg} forward error ${result.forwardErrorM!.toFixed(2)}m ` +
          `exceeds the ${fixture.tolerance_m}m tolerance (${fixture.control_point.description})`,
      ).toBeLessThanOrEqual(fixture.tolerance_m);

      // Round trip is a weaker check on its own -- a definition can be
      // self-consistently wrong -- but it catches a non-invertible or
      // numerically unstable projection that the forward check would pass.
      expect(
        result.roundTripErrorM!,
        `EPSG:${fixture.epsg} round-trip error ${result.roundTripErrorM!.toFixed(2)}m ` +
          `exceeds the ${fixture.tolerance_m}m tolerance`,
      ).toBeLessThanOrEqual(fixture.tolerance_m);

      expect(result.pass, `EPSG:${fixture.epsg} ${result.reason ?? 'failed verification'}`).toBe(true);
    });
  }
});
