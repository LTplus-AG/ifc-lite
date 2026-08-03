/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { parseIso8601Duration, secondsToIso8601Duration } from '../src/iso8601-duration.js';

describe('secondsToIso8601Duration — sub-second precision (#1963)', () => {
  it('does not round a sub-second lag away to PT0S', () => {
    // PR #1963 review: `Math.round(abs)` on the seconds component degrades
    // any fractional lag below 1s to PT0S — in the codec this PR just
    // consolidated specifically to make the round trip lossless.
    expect(secondsToIso8601Duration(0.5)).not.toBe('PT0S');
    expect(secondsToIso8601Duration(0.0001)).not.toBe('PT0S');
  });

  it('round-trips a fractional-second value through encode -> decode', () => {
    for (const seconds of [0.5, -0.5, 1.5, 90.25, 0.0001, -0.0001]) {
      const encoded = secondsToIso8601Duration(seconds);
      const decoded = parseIso8601Duration(encoded);
      expect(decoded).toBeCloseTo(seconds, 6);
    }
  });

  it('still emits the coarsest clean unit for whole values (no regression)', () => {
    expect(secondsToIso8601Duration(86_400)).toBe('P1D');
    expect(secondsToIso8601Duration(3_600)).toBe('PT1H');
    expect(secondsToIso8601Duration(60)).toBe('PT1M');
    expect(secondsToIso8601Duration(90)).toBe('PT90S');
    expect(secondsToIso8601Duration(-172_800)).toBe('-P2D');
  });

  it('emits a plain decimal, never exponent notation, for a very small magnitude', () => {
    // String(1e-7) would be "1e-7", which is not valid inside PT...S.
    const encoded = secondsToIso8601Duration(0.0000001);
    expect(encoded).not.toMatch(/e[+-]/i);
  });
});
