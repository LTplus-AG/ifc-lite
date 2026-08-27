/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `xs:double` accepts, against upstream IDS-Audit-tool (#3336).
 *
 * The contract is PARITY WITH UPSTREAM, not XSD. Upstream generates its
 * validator as a regex (`ids-lib.codegen/XmlSchema_XsTypesGenerator.cs`):
 *
 *     ^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$
 *
 * which is neither .NET nor XSD: it takes `+INF` (an XSD 1.1 spelling) while
 * rejecting bare `INF` (the 1.0 one), and rejects `Infinity` (the .NET one).
 * Each row below is that pattern's verdict, and each is asserted separately so
 * a failure names the literal rather than a set.
 */

import { describe, expect, it } from 'vitest';
import { literalCastsUnder } from './xsd-cast.js';

/** Upstream's own pattern, transcribed, as the oracle for the rows below. */
const UPSTREAM_DOUBLE_RE = /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/;

describe('xs:double specials, matching upstream (#3336)', () => {
  it.each(['NaN', '+INF', '-INF'])('accepts %j, which upstream accepts', (v) => {
    expect(UPSTREAM_DOUBLE_RE.test(v)).toBe(true);
    expect(literalCastsUnder(v, 'xs:double')).toBe(true);
  });

  it.each(['INF', 'Infinity'])('rejects %j, which upstream also rejects', (v) => {
    // `INF` is XSD 1.0 and `Infinity` is .NET. Upstream takes neither, and the
    // reason it takes `+INF` but not `INF` is that its pattern spells the
    // alternative `\+INF` rather than `\+?INF`.
    expect(UPSTREAM_DOUBLE_RE.test(v)).toBe(false);
    expect(literalCastsUnder(v, 'xs:double')).toBe(false);
  });

  it.each(['', '+', '.', '-', '+.', '-.', 'e5', 'E5', '+e5', '.e5'])(
    'rejects %j, a REPRESENTATIVE of the family we deviate from upstream on',
    (v) => {
      // Every part of upstream's pattern is optional, so it matches these. That
      // falls out of how the regex is written rather than being a decision, and
      // accepting an empty string as a double turns a malformed IDS literal
      // into a passing constraint. Asserting BOTH halves so the deviation stays
      // visible: if upstream ever tightens this, the first line fails and the
      // comment stops being true.
      //
      // REPRESENTATIVES, not the whole family. The exponent-only rows were
      // once a disagreement with our own coherence audit, which accepted them
      // because its digit veto was satisfied by the digit in the exponent.
      // That is fixed: the audit now requires the digit in the mantissa and
      // both sites reject these. `numeric-literal.test.ts` sweeps the two for
      // equality so they cannot part company again.
      expect(UPSTREAM_DOUBLE_RE.test(v)).toBe(true);
      expect(literalCastsUnder(v, 'xs:double')).toBe(false);
    },
  );

  it('still decides ordinary numbers the same way', () => {
    for (const v of ['1', '1.5', '-2e3', '+0.0']) {
      expect(literalCastsUnder(v, 'xs:double')).toBe(true);
    }
    for (const v of ['abc', '1.2.3', '1e', '12,0']) {
      expect(literalCastsUnder(v, 'xs:double')).toBe(false);
    }
  });

  it('leaves xs:integer alone', () => {
    // The specials belong to the floating types. An integer slot must not start
    // taking them just because the double arm does.
    for (const v of ['NaN', '+INF', '-INF']) {
      expect(literalCastsUnder(v, 'xs:integer')).toBe(false);
    }
    expect(literalCastsUnder('42', 'xs:integer')).toBe(true);
  });
});
