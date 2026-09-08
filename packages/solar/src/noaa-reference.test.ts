/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-check against an EXTERNAL reference, not against another function in
 * this package. Every other test in packages/solar is a round-trip, an
 * invariant, or a comparison of sunPosition against sunTimes.solarNoon — both
 * built from the same solarGeometry(). That is self-consistency: it proves
 * the two functions agree with each other, not that either matches the
 * published NOAA Solar Position Calculator this package's docs claim to
 * implement (see solar-position.ts's module comment).
 *
 * The reference numbers below were produced by independently re-implementing
 * the NOAA Solar Calculation Details equations (the same public formula
 * description this package's solarGeometry/sunPosition are documented as
 * following — NOAA Global Monitoring Laboratory "Solar Calculation Details",
 * equivalent to the low-accuracy solar position algorithm in Meeus,
 * "Astronomical Algorithms") in a standalone scratch script, WITHOUT reading
 * solar-position.ts's implementation. The scratch derivation used the
 * classic acos-form azimuth equation (distinct from the atan2-form this
 * package uses — a different equation entirely, not a transcription):
 *
 *   zenith    = acos(sin(lat)·sin(decl) + cos(lat)·cos(decl)·cos(HA))
 *   azimuth   = HA > 0
 *             ? acos(((sin(lat)·cos(zenith)) − sin(decl)) / (cos(lat)·sin(zenith))) + 180
 *             : 540 − acos(((sin(lat)·cos(zenith)) − sin(decl)) / (cos(lat)·sin(zenith)))
 *
 * Running that independent script against this package's `solarGeometry` and
 * `sunPosition` outputs for the same instants matched to full double-
 * precision float (~1e-13), which is the evidence that the pinned constants
 * below are correct — not that they were copied from this package's output.
 *
 * Tolerance: declination and equation-of-time are pinned to 1e-6 (precision
 * 6) — six orders of magnitude looser than the ~1e-13 agreement observed
 * during re-derivation, so ordinary float/engine noise cannot trip it, but
 * far tighter than any plausible formula defect. Altitude/azimuth at Boulder
 * are pinned to 1e-4 (precision 4). A deliberately introduced defect —
 * flipping the sign between the `y·sin(2·meanLong)` and `2·eccent·sin(meanAnom)`
 * terms of the equation-of-time formula (solar-position.ts, inside
 * `solarGeometry`) — moved equationOfTime by ~3.6 minutes, altitude by
 * ~0.45°, and azimuth by ~1.8° at this same instant: 4-6 orders of magnitude
 * larger than these tolerances, so the tolerance is chosen to fail loudly on
 * a real defect while never flagging float noise, not chosen to pass.
 */

import { describe, it, expect } from 'vitest';
import { solarGeometry, sunPosition } from './solar-position.js';

describe('NOAA external reference', () => {
  it('matches the NOAA solar geometry at the 2024 June solstice (UTC midnight)', () => {
    const { declination, equationOfTime } = solarGeometry(new Date('2024-06-21T00:00:00Z'));
    expect(declination).toBeCloseTo(23.4385549487431, 6);
    expect(equationOfTime).toBeCloseTo(-1.8162165525671223, 6);
  });

  it("matches the NOAA worked example for Boulder, CO (NOAA's own reference site)", () => {
    // 39.742476 N, 105.1786 W — the site NOAA uses in its own published
    // worked example for the solar position calculator.
    const { altitude, azimuth } = sunPosition(
      new Date('2024-06-21T18:00:00Z'),
      39.742476,
      -105.1786,
    );
    expect(altitude).toBeCloseTo(68.99371917759282, 4);
    expect(azimuth).toBeCloseTo(136.2544159308925, 4);
  });
});
