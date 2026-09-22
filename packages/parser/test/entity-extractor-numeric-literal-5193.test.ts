/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5193: `parseAttributeValue`'s numeric fallback trusted `parseFloat`, which
// accepts any leading numeric prefix and discards the rest. A corrupted
// literal with a dropped comma between two reals -- `1.52.3` -- parsed as the
// coordinate `1.52` with `Number.isFinite` passing and no diagnostic anywhere.
//
// The fix gates `parseFloat` behind `isCompleteStepNumericLiteral`
// (attribute-helpers.ts): the token must match the STEP REAL/INTEGER grammar
// in full, not just yield a finite prefix. A token that fails is preserved
// as the raw string -- the same refusal shape this function already applies
// to an overflowing literal like `1.0E400` -- rather than coerced to its
// truncated prefix.

import { describe, expect, it } from 'vitest';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

function extract(record: string) {
  const buffer = new TextEncoder().encode(record);
  const ref: EntityRef = { expressId: 1, type: 'IFCCARTESIANPOINT', byteOffset: 0, byteLength: buffer.length, lineNumber: 1 };
  return new EntityExtractor(buffer).extractEntity(ref);
}

describe('EntityExtractor: a corrupted numeric literal is refused, not truncated (#5193)', () => {
  it('a dropped comma -- "1.52.3" -- is preserved as the raw token, not truncated to 1.52', () => {
    const entity = extract('#1=IFCCARTESIANPOINT((1.52.3,4.0,5.0));');
    // The coordinate list is attribute 0; its first component is the
    // corrupted token. It must NOT silently become the number 1.52.
    expect(entity?.attributes).toEqual([['1.52.3', 4, 5]]);
  });

  it('trailing garbage -- "1.5abc" -- is likewise preserved, not truncated to 1.5', () => {
    const entity = extract('#1=IFCWALL(1.5abc);');
    expect(entity?.attributes).toEqual(['1.5abc']);
  });

  // ---------------------------------------------------------------------
  // No-regression pins: every legal form the issue calls out by name must
  // still parse to its exact numeric value. This is the likely failure mode
  // of an over-strict grammar check -- especially the bare-dot form ".5",
  // which has no digit before the decimal point.
  // ---------------------------------------------------------------------

  it('"1." parses to 1 (trailing dot, no fractional digits)', () => {
    const entity = extract('#1=IFCWALL(1.);');
    expect(entity?.attributes).toEqual([1]);
  });

  it('".5" parses to 0.5 (bare-dot decimal, no leading digit)', () => {
    const entity = extract('#1=IFCWALL(.5);');
    expect(entity?.attributes).toEqual([0.5]);
  });

  it('"1.E3" parses to 1000 (trailing dot then exponent)', () => {
    const entity = extract('#1=IFCWALL(1.E3);');
    expect(entity?.attributes).toEqual([1000]);
  });

  it('"+1.5" parses to 1.5 (explicit leading sign)', () => {
    const entity = extract('#1=IFCWALL(+1.5);');
    expect(entity?.attributes).toEqual([1.5]);
  });

  it('an overflowing literal -- "1.0E400" -- is still preserved as the string, not corrupted', () => {
    const entity = extract('#1=IFCWALL(1.0E400);');
    expect(entity?.attributes).toEqual(['1.0E400']);
  });

  it('$ / \'\' / * remain distinct from each other and from a malformed number', () => {
    const entity = extract("#1=IFCWALL($,'',*);");
    expect(entity?.attributes).toEqual([null, '', '*']);
  });
});
