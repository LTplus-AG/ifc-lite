/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shading-resolution sentence (#2042).
 *
 * DEFECT CLASS - a soft print read as a mis-scaled one. On a very large sheet
 * the raster hits a memory cap and the image gets blurrier while the placement
 * rectangle, which is computed from world bounds and never from pixels, stays
 * exact. A user who is told nothing has no way to tell those two apart, so the
 * dialog states the dpi it will actually get and says what is unaffected.
 *
 * The numbers below are derived by hand from the same arithmetic the exporter
 * hands the rasteriser (ceil(mm * dpi / 25.4), then both sides scaled by
 * sqrt(cap / requested)), so a drifting cap or a dropped ceil moves them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeShadingResolution } from './PdfViewAppearanceSection.js';

describe('describeShadingResolution (#2042)', () => {
  it('states the plain resolution for a sheet that fits the caps', () => {
    // 40 x 30 mm of drawing at 150 dpi is 237 x 178 px, nowhere near 2^24.
    assert.equal(describeShadingResolution(40, 30), 'Shading resolution: 150 dpi.');
  });

  it('names the reduced resolution, and what stays exact, when the cap engages', () => {
    // 5000 x 4000 mm asks for 29528 x 23623 px = 697,539,944 px, far past the
    // 16,777,216 cap. Both sides scale by sqrt(16777216 / 697539944) =
    // 0.15509, so the achievable resolution is 150 * 0.15509 = 23.26 dpi.
    const note = describeShadingResolution(5000, 4000);
    assert.equal(
      note,
      'Shading resolution: 23 dpi (reduced from 150 to keep the image within ' +
        'memory limits). Line work stays vector and exact.',
    );
  });

  it('says nothing at all rather than guessing when the page is unknown', () => {
    // `fitRasterPixels` throws on a non-positive size by design, so a dialog
    // that called it with a page it has not computed yet would take the whole
    // export dialog down on a keystroke.
    assert.equal(describeShadingResolution(null, null), null);
    assert.equal(describeShadingResolution(40, null), null);
    assert.equal(describeShadingResolution(0, 30), null);
    assert.equal(describeShadingResolution(Number.NaN, 30), null);
  });
});
