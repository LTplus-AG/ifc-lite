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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDistance, formatDistanceDisplay } from './formatDistance.js';

describe('formatDistanceDisplay', () => {
  it('falls back to the auto-scaled metric string when no override is set', () => {
    assert.strictEqual(formatDistanceDisplay(3, {}), formatDistance(3));
    assert.strictEqual(formatDistanceDisplay(0.25, {}), formatDistance(0.25));
  });

  it('falls back when overrides carries an unrelated unit type', () => {
    assert.strictEqual(formatDistanceDisplay(6.824, { AREAUNIT: 'ft2' }), formatDistance(6.824));
  });

  it('converts into the LENGTHUNIT override instead of auto-scaled metric', () => {
    // 1 m3 cube edge from the maintainer's own verification numbers: 1.000 m
    // measured, which at 3.28084 ft/m is 3.2808 ft, capped to 4 fraction
    // digits by formatConverted.
    assert.strictEqual(formatDistanceDisplay(1, { LENGTHUNIT: 'ft' }), '3.2808 ft');
  });

  it('converts a sub-metre distance the same way the auto-scaled path would have shown as cm', () => {
    // 0.25 m -> formatDistance would say "25.0 cm"; the override must win
    // instead of the auto cm/mm scaling.
    assert.strictEqual(formatDistanceDisplay(0.25, { LENGTHUNIT: 'ft' }), '0.8202 ft');
  });

  it('converts into the millimetre override', () => {
    // Kept under 1000 so a locale's thousands-separator can't make this
    // assertion flaky — formatConverted's grouping is exercised separately
    // in lib/units/display.test.ts.
    assert.strictEqual(formatDistanceDisplay(0.00125, { LENGTHUNIT: 'mm' }), '1.25 mm');
  });
});
