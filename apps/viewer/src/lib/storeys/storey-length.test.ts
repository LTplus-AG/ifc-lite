/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9037 review: storey lengths show two decimals unless the millimetre matters. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatElevation, formatHeight } from './storey-length.js';

describe('storey length formatting (#9013)', () => {
  it('keeps two decimals for centimetre values that binary floating point cannot hold exactly', () => {
    assert.equal(formatElevation(1.1), '+1.10');
    assert.equal(formatElevation(-0.29), '−0.29');
    assert.equal(formatHeight(3.1), '3.10');
    assert.equal(formatHeight(2.3), '2.30');
  });

  it('shows the millimetre when it matters, and ±0.00 at zero', () => {
    assert.equal(formatElevation(3.125), '+3.125');
    assert.equal(formatHeight(0.005), '0.005');
    assert.equal(formatElevation(0), '±0.00');
  });
});
