/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import type { EntityRef } from './types.js';

/** Build an EntityExtractor over a single STEP record and extract it. */
function extract(record: string) {
  const bytes = new TextEncoder().encode(record);
  const ref: EntityRef = {
    expressId: 1,
    type: 'IFCPROPERTYSINGLEVALUE',
    byteOffset: 0,
    byteLength: bytes.length,
    lineNumber: 1,
  };
  return new EntityExtractor(bytes).extractEntity(ref);
}

describe('EntityExtractor typed-value unwrapping', () => {
  it('unwraps a single-line typed string value', () => {
    const ent = extract(`#1=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('3410_balustrades'),$);`);
    expect(ent?.attributes[2]).toEqual(['IFCLABEL', '3410_balustrades']);
  });

  it('unwraps a typed string value whose text is broken across physical lines', () => {
    // Authoring tools wrap long STEP lines; a raw newline can land inside the
    // string literal. The typed value must still be decomposed, not leaked as a
    // raw `IFCLABEL('...')` literal.
    const ent = extract(
      `#1=IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('3410_balustrades en leuningen\r\n - balustrades'),$);`,
    );
    expect(ent?.attributes[2]).toEqual([
      'IFCLABEL',
      '3410_balustrades en leuningen\r\n - balustrades',
    ]);
  });

  it('unwraps a numeric typed value split across lines and keeps it numeric', () => {
    const ent = extract(`#1=IFCPROPERTYSINGLEVALUE('N',$,IFCREAL(\r\n1.5\r\n),$);`);
    expect(ent?.attributes[2]).toEqual(['IFCREAL', 1.5]);
  });
});

describe('EntityExtractor MAX_PARSE_DEPTH guard', () => {
  // parseAttributeValue recurses once per nesting level of a parenthesised
  // list/typed-value attribute. Unguarded, a hostile or corrupted file can
  // nest deep enough to blow the JS call stack — verified directly: with the
  // depth check disabled, a ~200k-deep nested attribute throws
  // "RangeError: Maximum call stack size exceeded" from inside
  // parseAttributeValue, which propagates up and is caught by extractEntity's
  // try/catch — losing the ENTIRE entity (all attributes, including
  // unrelated sibling values) rather than just the one malformed attribute.
  // The MAX_PARSE_DEPTH=100 guard localizes the failure: only the
  // over-nested attribute value is truncated to null; sibling attributes on
  // the same entity are unaffected.

  /** Build a STEP record whose middle attribute is nested `depth` levels deep: `(((...(#1)...)))`. */
  function nestedRecord(depth: number): string {
    const nested = '('.repeat(depth) + '#1' + ')'.repeat(depth);
    return `#1=IFCPROPERTYSINGLEVALUE('Head',${nested},'Tail');`;
  }

  /** Descend through nested single-element arrays to the innermost value. */
  function innermost(value: unknown): unknown {
    let v = value;
    while (Array.isArray(v) && v.length === 1) v = v[0];
    return v;
  }

  it('parses a 100-level-deep nested attribute fully (at the guard boundary)', () => {
    const ent = extract(nestedRecord(100));
    expect(ent).not.toBeNull();
    expect(ent?.attributes[0]).toBe('Head');
    expect(ent?.attributes[2]).toBe('Tail');
    // At exactly MAX_PARSE_DEPTH the innermost #1 reference is still resolved.
    expect(innermost(ent?.attributes[1])).toBe(1);
  });

  it('truncates a 101-level-deep nested attribute to null but preserves sibling attributes', () => {
    const ent = extract(nestedRecord(101));
    expect(ent).not.toBeNull();
    // The guard must localize the failure: attributes before/after the
    // over-nested one are untouched, not lost along with the whole entity.
    expect(ent?.attributes[0]).toBe('Head');
    expect(ent?.attributes[2]).toBe('Tail');
    // One level past the guard, the innermost value is null (truncated),
    // not the resolved reference `1`.
    expect(innermost(ent?.attributes[1])).toBeNull();
  });
});
