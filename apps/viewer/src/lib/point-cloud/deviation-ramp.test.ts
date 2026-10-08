/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DEVIATION_RAMP_CSS_GRADIENT, deviationRampColor } from './deviation-ramp.js';

it('#6872 histogram bars sample the same piecewise-linear ramp as the legend and the splat shader', () => {
  // The three stops are the legend gradient's own stops, in order.
  const stops = [-1, 0, 1].map(deviationRampColor);
  assert.equal(DEVIATION_RAMP_CSS_GRADIENT, `linear-gradient(to right, ${stops.join(', ')})`);
  assert.deepEqual(stops, ['rgb(26,77,217)', 'rgb(242,242,242)', 'rgb(217,51,26)']);
  // Halfway along the warm side is the channel-wise midpoint (shader `mix`).
  assert.equal(deviationRampColor(0.5), 'rgb(230,147,134)');
  assert.equal(deviationRampColor(-0.5), 'rgb(134,160,230)');
  // Past the range the colour saturates, like `clamp(t, -1, 1)` in WGSL.
  assert.equal(deviationRampColor(7), stops[2]);
  assert.equal(deviationRampColor(Number.NaN), stops[1]);
});
