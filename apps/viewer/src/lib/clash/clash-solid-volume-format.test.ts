/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for the CodeRabbit #2574 review thread on
 * `ClashPanel.tsx#L805-806`: "`toFixed(3)` displays every valid volume below
 * `0.0005 m³` as `0.000 m³`." Pins the exact boundary and that ordinary
 * volumes are unaffected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatClashSolidVolumeM3 } from './clash-solid-volume-format.js';

describe('formatClashSolidVolumeM3', () => {
  it('keeps the plain toFixed(3) form for an ordinary volume', () => {
    // 1.2345 has no exact binary representation; (1.2345).toFixed(3) is
    // '1.234' in JS (floating-point rounding, not this function's doing) —
    // asserted here so this test pins the SAME rounding `toFixed` always did.
    assert.equal(formatClashSolidVolumeM3(1.2345), '1.234 m³');
  });

  it('keeps toFixed(3) right at the rounding boundary (0.0005 rounds up to 0.001)', () => {
    assert.equal(formatClashSolidVolumeM3(0.0005), '0.001 m³');
  });

  it('falls back to scientific notation for a real solid smaller than the boundary', () => {
    // A 10mm x 10mm x 2mm sliver: 2e-7 m^3 — a genuine `isSolid: true` result
    // that `toFixed(3)` alone would print as "0.000 m³".
    const out = formatClashSolidVolumeM3(0.0000002);
    assert.notEqual(out, '0.000 m³', 'a nonzero solid must never read as zero volume');
    assert.equal(out, '2.00e-7 m³');
  });

  it('a genuinely zero volume still reads as 0.000 m³', () => {
    assert.equal(formatClashSolidVolumeM3(0), '0.000 m³');
  });
});
