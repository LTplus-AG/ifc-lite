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

describe('secondsToIso8601Duration — second CodeRabbit round on #1963', () => {
  it('emits a value its own decoder can read back for very large magnitudes (item 1)', () => {
    // Maintainer's probe: the integer branch interpolates `${abs}` directly,
    // which is plain decimal only up to 1e21 — above that JS switches to
    // exponent notation ("1e+21"), which parseIso8601Duration's regex does
    // not accept. An encoder whose own decoder rejects its output is the bug.
    const encoded = secondsToIso8601Duration(1e21);
    expect(encoded).not.toMatch(/e[+-]/i);
    const decoded = parseIso8601Duration(encoded);
    expect(decoded).toBeCloseTo(1e21, -5); // relative tolerance; magnitude is what matters
  });

  it('refuses non-finite input instead of fabricating PT0S (item 2)', () => {
    // NaN / Infinity are not "zero lag" — PT0S is a legitimate value, so
    // returning it for broken input invents a real-looking answer. Refuse:
    // return undefined so no IFCLAGTIME is emitted, matching how an
    // unrepresentable lag is already handled elsewhere in this codec.
    expect(secondsToIso8601Duration(NaN)).toBeUndefined();
    expect(secondsToIso8601Duration(Infinity)).toBeUndefined();
    expect(secondsToIso8601Duration(-Infinity)).toBeUndefined();
  });

  it('round-trips the maintainer probe table exactly (item 3)', () => {
    // NaN / Infinity: refused (item 2). Math.PI: precision preserved beyond
    // the old toFixed(9) floor. 1e21: no exponent notation (item 1).
    // 1e-10: still round-trips at reduced precision (a real value, not zero).
    expect(secondsToIso8601Duration(NaN)).toBeUndefined();
    expect(secondsToIso8601Duration(Infinity)).toBeUndefined();

    const piEncoded = secondsToIso8601Duration(Math.PI);
    expect(piEncoded).not.toMatch(/e[+-]/i);
    expect(parseIso8601Duration(piEncoded)).toBeCloseTo(Math.PI, 12);

    const bigEncoded = secondsToIso8601Duration(1e21);
    expect(bigEncoded).not.toMatch(/e[+-]/i);
    expect(parseIso8601Duration(bigEncoded)).toBeCloseTo(1e21, -5);

    const tinyEncoded = secondsToIso8601Duration(1e-10);
    expect(tinyEncoded).not.toMatch(/e[+-]/i);
    expect(parseIso8601Duration(tinyEncoded)).toBeCloseTo(1e-10, 15);
  });

  it('rejects a trailing bare "T" with no time component (item 4)', () => {
    // "P1DT" has a date part but an empty time designator — malformed, and
    // we already reject bare "P"/"PT" for the same reason (a component-less
    // duration that would otherwise silently parse as 0 or, here, drop the
    // T entirely and misparse). Reject "-P1DT" too.
    expect(parseIso8601Duration('P1DT')).toBeUndefined();
    expect(parseIso8601Duration('-P1DT')).toBeUndefined();
    // Sanity: a real time component after T still parses.
    expect(parseIso8601Duration('P1DT1H')).toBe(90000);
  });
});

describe('parseIso8601Duration — third CodeRabbit round on #1963', () => {
  const hugeDigits = '9'.repeat(320);

  it('refuses an absurd magnitude instead of returning ±Infinity', () => {
    // Maintainer's finding: the encoder already refuses non-finite input
    // (secondsToIso8601Duration(Infinity) -> undefined), so a decoder that
    // accepts a value large enough to overflow to Infinity is the mirror of
    // the asymmetry this branch already closed three times (bare P/PT,
    // trailing P1DT, non-finite on encode). Refuse here too, before the sign
    // is applied, so the negative form is refused identically.
    expect(parseIso8601Duration(`P${hugeDigits}Y`)).toBeUndefined();
    expect(parseIso8601Duration(`PT${hugeDigits}S`)).toBeUndefined();
    expect(parseIso8601Duration(`-P${hugeDigits}Y`)).toBeUndefined();
  });

  it('still parses ordinary finite values (no regression)', () => {
    expect(parseIso8601Duration('P1D')).toBe(86400);
    expect(parseIso8601Duration('-P2D')).toBe(-172800);
    expect(parseIso8601Duration('P1DT1H')).toBe(90000);
  });
});
