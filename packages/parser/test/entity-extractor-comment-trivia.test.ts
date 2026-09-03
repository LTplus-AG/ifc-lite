/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// PR #3675 fixed the SCANNER: a STEP `/* ... */` comment inside a record is
// trivia, so the byte SPAN handed to every decoder is now correct even when a
// comment sits between the instance name and its `=`, or holds a `;`, `'` or
// `(` that would otherwise have truncated the record.
//
// The follow-up, documented in issue #3673 and left unfixed by that PR on
// purpose: the ATTRIBUTE-DECODE layer -- this file's target, `EntityExtractor`
// -- was still comment-blind. Given a correct span, it read the comment's own
// text into the value it precedes: `/* rev; b */ $` decoded as the STRING
// `"/* rev; b */ $"` rather than as `null`. Positions were right; the value
// text was polluted, and worse, a comment in front of a `$` made a genuinely
// UNSET attribute look set.

import { describe, expect, it } from 'vitest';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

function extract(record: string) {
  const buffer = new TextEncoder().encode(record);
  const ref: EntityRef = { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: buffer.length, lineNumber: 1 };
  return new EntityExtractor(buffer).extractEntity(ref);
}

describe('EntityExtractor: a comment is trivia inside a decoded attribute list too', () => {
  it('does not pollute the value a comment precedes -- the exact shape from #3673', () => {
    const entity = extract("#1=IFCWALL('a', /* rev; b */ $, 'c');");
    expect(entity?.attributes).toEqual(['a', null, 'c']);
  });

  it('a comment before $ still decodes as null, not as a non-null string', () => {
    const entity = extract('#1=IFCWALL(/* c1 */ $);');
    expect(entity?.attributes).toEqual([null]);
  });

  it('a comma inside a comment is not an attribute separator', () => {
    const entity = extract("#1=IFCWALL('a', /* x, y */ 5);");
    expect(entity?.attributes).toEqual(['a', 5]);
  });

  it('a semicolon inside a comment is not read as structure', () => {
    const entity = extract("#1=IFCWALL('a', /* rev; note */ 5);");
    expect(entity?.attributes).toEqual(['a', 5]);
  });

  it('a comment inside a nested list is trivia too', () => {
    const entity = extract('#1=IFCWALL((#2, /* skip */ #3));');
    expect(entity?.attributes).toEqual([[2, 3]]);
  });

  it('a quote inside a comment does not open a string, and a paren inside one is not structure', () => {
    const entity = extract("#1=IFCWALL(/* don't reuse IFCWALL( */ 'a', $);");
    expect(entity?.attributes).toEqual(['a', null]);
  });

  // ---------------------------------------------------------------------
  // Composition, the other direction: a value that merely CONTAINS the
  // comment delimiter must not be treated as one.
  // ---------------------------------------------------------------------

  it('a string containing /* is unchanged -- it is text, not a comment opener', () => {
    const entity = extract("#1=IFCWALL('has /* not a comment */ text');");
    expect(entity?.attributes).toEqual(['has /* not a comment */ text']);
  });

  // ---------------------------------------------------------------------
  // Control: a comment-free record decodes byte-identically to before.
  // ---------------------------------------------------------------------

  it('a comment-free record decodes unchanged', () => {
    const entity = extract("#123=IFCWALL('guid','owner',$,$,'name',$,$,$);");
    expect(entity?.expressId).toBe(123);
    expect(entity?.type).toBe('IFCWALL');
    expect(entity?.attributes).toEqual(['guid', 'owner', null, null, 'name', null, null, null]);
  });
});
