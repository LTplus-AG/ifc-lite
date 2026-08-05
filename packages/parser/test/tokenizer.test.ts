/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for {@link StepTokenizer}, the byte-level STEP scanner every
 * model in the product passes through.
 *
 * Before this file the tokenizer had no test of its own: it was only ever
 * exercised transitively through `IfcParser`, whose fixtures never contain a
 * malformed record, a multi-line entity whose line number is asserted, or two
 * type names that collide in the fast scanner's type cache. Mutation testing
 * confirmed the gap — nine independent mutations to `tokenizer.ts` (including
 * making the whole `scanEntities()` generator yield nothing) left the entire
 * monorepo green.
 */

import { describe, expect, it } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const scanFast = (s: string) => [...new StepTokenizer(bytes(s)).scanEntitiesFast()];
const scanSlow = (s: string) => [...new StepTokenizer(bytes(s)).scanEntities()];

describe('StepTokenizer.scanEntitiesFast', () => {
  it('reports a byte length that spans the record up to and including the terminating semicolon', () => {
    const src = "#1=IFCWALL('a');";
    const [ref] = scanFast(src);
    expect(ref).toBeDefined();
    // The whole record, semicolon included — downstream slices `source` with
    // this length, so an off-by-one drops the record terminator.
    expect(ref.length).toBe(src.length);
    expect(src.slice(ref.offset, ref.offset + ref.length)).toBe(src);
    expect(src[ref.offset + ref.length - 1]).toBe(';');
  });

  it('rejects a type token that does not start with an uppercase letter', () => {
    // STEP entity keywords are uppercase. A lowercase token after `=` is not a
    // type name; accepting it invents entities out of malformed input.
    expect(scanFast('#1=ifcwall(1);')).toEqual([]);
    expect(scanFast('#1=_priv(1);')).toEqual([]);
    // ...but a legitimately uppercase-initial name is still accepted.
    expect(scanFast('#1=IFCWALL(1);').map((r) => r.type)).toEqual(['IFCWALL']);
  });

  it('counts newlines inside a multi-line record so later entities keep true line numbers', () => {
    const src = ['#1=IFCWALL(', "  'name',", '  $', ');', '#2=IFCSLAB($);'].join('\n');
    const refs = scanFast(src);
    expect(refs.map((r) => r.expressId)).toEqual([1, 2]);
    expect(refs[0].line).toBe(1);
    // #2 sits on the 5th line; the three newlines inside #1's body must count.
    expect(refs[1].line).toBe(5);
  });

  it('treats a quoted semicolon as string content, not as the end of the record', () => {
    const src = "#1=IFCWALL('has ; semicolon');\n#2=IFCSLAB($);";
    const refs = scanFast(src);
    expect(refs.map((r) => r.expressId)).toEqual([1, 2]);
    expect(refs[0].length).toBe("#1=IFCWALL('has ; semicolon');".length);
  });

  it('closes the string at a doubled-quote escape rather than staying inside it', () => {
    // `''` is the STEP escape for a literal apostrophe. The scanner must
    // consume both quotes without flipping out of string state, and must then
    // still recognise the closing quote and the record terminator.
    const src = "#1=IFCWALL('it''s here');\n#2=IFCSLAB($);";
    const refs = scanFast(src);
    expect(refs.map((r) => r.expressId)).toEqual([1, 2]);
    expect(refs[0].length).toBe("#1=IFCWALL('it''s here');".length);
  });

  it('does not alias two type names that collide in the type-name cache', () => {
    // The fast scanner caches decoded type names under a `length:hash` key to
    // avoid millions of allocations. `Aa` and `BB` are the same length and
    // produce the same 32-bit rolling hash, so the cache key alone cannot tell
    // them apart — only the byte-for-byte verification of a cache hit can.
    // Without it a hostile or corrupt file has one type silently read as
    // another (a door reported as a wall).
    const refs = scanFast('#1=Aa(1);\n#2=BB(1);\n#3=Aa(1);');
    expect(refs.map((r) => r.type)).toEqual(['Aa', 'BB', 'Aa']);
  });

  it('keeps colliding type names distinct even when their lengths differ', () => {
    // `DHMWK` and `LILQAGG` share a rolling hash but not a length.
    const refs = scanFast('#1=DHMWK(1);\n#2=LILQAGG(1);\n#3=DHMWK(1);');
    expect(refs.map((r) => r.type)).toEqual(['DHMWK', 'LILQAGG', 'DHMWK']);
  });

  it('reuses one interned string for a repeated type name', () => {
    const refs = scanFast('#1=IFCWALL(1);\n#2=IFCWALL(1);');
    expect(refs[0].type).toBe(refs[1].type);
  });
});

describe('StepTokenizer.scanEntities (paren-matching scan)', () => {
  it('yields each entity with the byte span its matching close paren defines', () => {
    const src = "#1=IFCWALL('a',#2);\n#2=IFCSLAB($);";
    const refs = scanSlow(src);
    expect(refs.map((r) => r.expressId)).toEqual([1, 2]);
    expect(refs.map((r) => r.type)).toEqual(['IFCWALL', 'IFCSLAB']);
    expect(refs[0].line).toBe(1);
    expect(refs[1].line).toBe(2);
    // Length runs from `#` to the matching `)` (the semicolon is not included
    // on this path — the close paren terminates the record).
    expect(src.slice(refs[0].offset, refs[0].offset + refs[0].length))
      .toBe("#1=IFCWALL('a',#2)");
  });

  it('tracks nested parentheses so a nested list does not close the record early', () => {
    const src = '#1=IFCPOLYLOOP(((0.,0.),(1.,1.)),$);';
    const [ref] = scanSlow(src);
    expect(ref).toBeDefined();
    expect(src.slice(ref.offset, ref.offset + ref.length))
      .toBe('#1=IFCPOLYLOOP(((0.,0.),(1.,1.)),$)');
  });

  it('ignores parentheses that appear inside a quoted string', () => {
    // A `)` inside a string must not decrement the nesting depth; if it does,
    // the record is truncated mid-string and every downstream attribute read
    // sees a malformed record.
    const src = "#1=IFCWALL('closing ) paren',$);";
    const [ref] = scanSlow(src);
    expect(ref).toBeDefined();
    expect(src.slice(ref.offset, ref.offset + ref.length))
      .toBe("#1=IFCWALL('closing ) paren',$)");
  });

  it('ignores an unbalanced open paren inside a quoted string', () => {
    const src = "#1=IFCWALL('opening ( paren',$);\n#2=IFCSLAB($);";
    const refs = scanSlow(src);
    expect(refs.map((r) => r.expressId)).toEqual([1, 2]);
    expect(src.slice(refs[0].offset, refs[0].offset + refs[0].length))
      .toBe("#1=IFCWALL('opening ( paren',$)");
  });

  it('yields nothing for a `#` that carries no express id', () => {
    // `readExpressId` must reject a digitless `#`; accepting it would mint an
    // entity with expressId 0 that collides with every other malformed marker.
    expect(scanSlow('#=IFCWALL(1);')).toEqual([]);
    expect(scanFast('#=IFCWALL(1);')).toEqual([]);
  });

  it('yields nothing when the record never closes its parenthesis', () => {
    expect(scanSlow("#1=IFCWALL('a',$")).toEqual([]);
  });
});
