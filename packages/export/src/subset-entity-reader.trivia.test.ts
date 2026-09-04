/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readEntityArgs` had the same type-name/paren adjacency gap #3789 fixed in
 * the other record readers: a record whose type name is separated from its
 * `(` by a line wrap or a `/* ... *​/` comment read as unparseable and came
 * back `null`, which `anonymize-placement.ts` and `anonymize-scrub.ts` treat
 * as "not a source-backed entity" and skip -- so a wrapped placement was
 * silently left un-scrubbed rather than reported.
 */

import { describe, it, expect } from 'vitest';
import { asSourceBytes } from '@ifc-lite/parser';
import { readEntityArgs, type EntityByteRangeIndex } from './subset-entity-reader.js';

function store(record: string): { store: { readonly source: ReturnType<typeof asSourceBytes> }; index: EntityByteRangeIndex } {
  const bytes = new TextEncoder().encode(record);
  return {
    store: { source: asSourceBytes(bytes) },
    index: { get: (id: number) => (id === 1 ? { byteOffset: 0, byteLength: bytes.byteLength, type: 'IFCLOCALPLACEMENT' } : undefined) },
  };
}

describe('readEntityArgs tolerates STEP trivia between the type name and "("', () => {
  it.each([
    ['adjacent (control)', "#1=IFCLOCALPLACEMENT($,#9);"],
    ['CRLF line wrap', "#1=IFCLOCALPLACEMENT\r\n($,#9);"],
    ['space', "#1=IFCLOCALPLACEMENT ($,#9);"],
    ['block comment', "#1=IFCLOCALPLACEMENT/* c */($,#9);"],
    ['whitespace and comment interleaved', "#1=IFCLOCALPLACEMENT /* a */\t($,#9);"],
  ])('reads the arguments through %s', (_name, record) => {
    const { store: s, index } = store(record);
    expect(readEntityArgs(s, index, 1)).toEqual({ type: 'IFCLOCALPLACEMENT', args: ['$', '#9'] });
  });

  it.each([
    ['U+00A0 is not STEP whitespace (#3733)', '#1=IFCLOCALPLACEMENT\u00a0($,#9);'],
    ['an entity reference is not trivia', "#1=IFCLOCALPLACEMENT#5($,#9);"],
    ['an unterminated comment', "#1=IFCLOCALPLACEMENT/*($,#9);"],
    ['"//" is not a STEP comment', "#1=IFCLOCALPLACEMENT//x\n($,#9);"],
  ])('still refuses %s', (_name, record) => {
    const { store: s, index } = store(record);
    expect(readEntityArgs(s, index, 1)).toBeNull();
  });
});
