/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `formatDistance()` ignoring `unitDisplayOverrides` — issue #2199,
 * maintainer's "worth its own small fix" note. A user who has set feet as
 * the LENGTHUNIT display override still got metres from every measure-tool
 * distance readout; #2514 only wired the override through
 * `resolveQuantityDisplay` for element quantities (area/volume/weight), not
 * for the distances the measure tool itself produces.
 *
 * `formatDistance` is the single distance formatter — the maintainer's deep
 * review on #2538 flagged that a separate `formatDistanceDisplay` beside an
 * unconditionally-metric `formatDistance` left every measure-tool call site
 * free to pick either name and silently get an unconverted result. The
 * override handling was folded into `formatDistance` itself instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDistance, formatSignedTriple } from './formatDistance.js';

describe('formatDistance', () => {
  it('falls back to the auto-scaled metric string when overrides is omitted', () => {
    assert.strictEqual(formatDistance(3), '3.000 m');
    assert.strictEqual(formatDistance(0.25), '25.0 cm');
  });

  it('falls back to the auto-scaled metric string when no override is set', () => {
    assert.strictEqual(formatDistance(3, {}), formatDistance(3));
    assert.strictEqual(formatDistance(0.25, {}), formatDistance(0.25));
  });

  it('falls back when overrides carries an unrelated unit type', () => {
    assert.strictEqual(formatDistance(6.824, { AREAUNIT: 'ft2' }), formatDistance(6.824));
  });

  it('converts into the LENGTHUNIT override instead of auto-scaled metric', () => {
    // 1 m3 cube edge from the maintainer's own verification numbers: 1.000 m
    // measured, which at 3.28084 ft/m is 3.2808 ft, capped to 4 fraction
    // digits by formatConverted.
    assert.strictEqual(formatDistance(1, { LENGTHUNIT: 'ft' }), '3.2808 ft');
  });

  it('converts a sub-metre distance the same way the auto-scaled path would have shown as cm', () => {
    // 0.25 m -> the no-override path says "25.0 cm"; the override must win
    // instead of the auto cm/mm scaling.
    assert.strictEqual(formatDistance(0.25, { LENGTHUNIT: 'ft' }), '0.8202 ft');
  });

  it('converts into the millimetre override', () => {
    // Kept under 1000 so a locale's thousands-separator can't make this
    // assertion flaky — formatConverted's grouping is exercised separately
    // in lib/units/display.test.ts.
    assert.strictEqual(formatDistance(0.00125, { LENGTHUNIT: 'mm' }), '1.25 mm');
  });
});

// #2538 deep review: MeasurePointReadout's "Rel. ref" row converted only its
// trailing distance hint, leaving the X/Y/Z triple beside it in unlabelled
// metres — a `ft` override made the row read a metre triple next to a feet
// distance. `formatSignedTriple` is the fix: the same LENGTHUNIT conversion
// `formatDistance` applies to the hint, applied per axis to the triple.
describe('formatSignedTriple', () => {
  it('keeps the pre-#2199 unlabelled-metres triple when overrides is omitted', () => {
    assert.strictEqual(formatSignedTriple({ x: 1, y: 2, z: 3 }), 'X 1.000  Y 2.000  Z 3.000');
  });

  it('keeps the unlabelled-metres triple for an empty override map', () => {
    assert.strictEqual(formatSignedTriple({ x: 1, y: 2, z: 3 }, {}), 'X 1.000  Y 2.000  Z 3.000');
  });

  it('converts every axis into the LENGTHUNIT override, matching formatDistance per axis', () => {
    // 1 m -> 3.2808 ft, 2 m -> 6.5617 ft, 3 m -> 9.8425 ft (3.28084 ft/m).
    assert.strictEqual(
      formatSignedTriple({ x: 1, y: 2, z: 3 }, { LENGTHUNIT: 'ft' }),
      'X 3.2808  Y 6.5617  Z 9.8425',
    );
  });

  it('keeps negative axes signed after conversion', () => {
    assert.strictEqual(
      formatSignedTriple({ x: -1, y: 0, z: 3.048 }, { LENGTHUNIT: 'ft' }),
      'X -3.2808  Y 0  Z 10',
    );
  });
});
