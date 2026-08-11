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

  // NOT "reuses one interned string": the cache is a memory optimisation and
  // is not observable from JS. `expect(a).toBe(b)` is `Object.is`, which
  // compares string PRIMITIVES by value, so a decoded-fresh name satisfies it
  // exactly as an interned one does — deleting the `typeCache.set(...)` call
  // outright left this file green. The two collision tests above carry the
  // real, falsifiable property (the byte-for-byte verification of a cache
  // hit); this one only pins that a plain repeat reads back correctly.
  it('reads a repeated type name back identically on the cache-hit path', () => {
    const refs = scanFast('#1=IFCWALL(1);\n#2=IFCWALL(1);');
    expect(refs.map((r) => r.type)).toEqual(['IFCWALL', 'IFCWALL']);
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

describe('StepTokenizer and STEP comments', () => {
  // A commented-out record is well-formed: it has its `#id`, its `=`, its
  // uppercase type and its parenthesised arguments. So the #856 guard, which
  // requires an `=` after `#<digits>`, accepts it, and only skipping the
  // comment as a region rejects it. Real files ship elements commented out for
  // a revision, and reviving one puts an entity the author deleted back into
  // the model and into any file written from that model.
  const cases = [
    ['fast', scanFast],
    ['slow', scanSlow],
  ] as const;

  for (const [name, scan] of cases) {
    it(`${name}: does not yield a record that is commented out`, () => {
      const src = ["#1=IFCWALL('a');", "/*#2=IFCWALL('b');*/", "#3=IFCWALL('c');"].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1, 3]);
    });

    it(`${name}: keeps line numbers correct when a record itself spans lines`, () => {
      // Newlines inside a record, not inside a comment. Every multi-line test
      // here put them in comments, which left the record case uncovered, and
      // the slow scanner was double-counting the newlines between `#1=` and its
      // type name: once while matching, once again when stepping past the
      // record. A newline there is ordinary whitespace and legal.
      const src = ["#1=", "IFCWALL('a');", "#2=IFCWALL('b');"].join('\n');
      expect(scan(src).map((r) => [r.expressId, r.line])).toEqual([
        [1, 1],
        [2, 3],
      ]);
    });

    it(`${name}: keeps line numbers correct across a multi-line comment`, () => {
      // The skip has to count the newlines it jumps. Without that, records
      // after a comment report a line number that is too low, and that only
      // ever surfaces inside an error message about something else.
      const src = ["#1=IFCWALL('a');", '/* two', 'three', 'four */', "#2=IFCWALL('b');"].join('\n');
      expect(scan(src).map((r) => [r.expressId, r.line])).toEqual([
        [1, 1],
        [2, 5],
      ]);
    });

    it(`${name}: stops at an unterminated comment rather than resuming inside it`, () => {
      const src = ["#1=IFCWALL('a');", '/* never closed', "#2=IFCWALL('b');"].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1]);
    });

    it(`${name}: does not treat a lone slash as a comment`, () => {
      // STEP values and unit expressions carry bare '/'. Skipping on one would
      // swallow the rest of the file.
      const src = ["#1=IFCWALL('a/b');", "#2=IFCWALL('c');"].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1, 2]);
    });

    it(`${name}: does not treat a slash-star inside a string literal as a comment`, () => {
      // The one input that separated the two scanners. scanEntities used to
      // leave position at the record's '(' and re-walk the body with no string
      // state, which was harmless while an interior '#' merely failed the '='
      // guard, and stopped being harmless once the loop also reacted to '/*':
      // the slash-star below opened a comment and swallowed #2 and everything
      // after it. scanEntities now steps past a matched record, as the Rust
      // EntityScanner does, so the outer loop is never inside a DATA string.
      const unterminated = ["#1=IFCWALL('a /* b');", "#2=IFCWALL('c');"].join('\n');
      expect(scan(unterminated).map((r) => r.expressId)).toEqual([1, 2]);

      // Same shape, with a later `*/` in a second literal. The failure mode
      // there is a skip rather than a stop, so it needs its own input.
      const closed = ["#1=IFCWALL('a /* b');", "#2=IFCWALL('z */ w');", "#3=IFCWALL('q');"].join('\n');
      expect(scan(closed).map((r) => r.expressId)).toEqual([1, 2, 3]);
    });

    it(`${name}: a slash-star in a HEADER string does not open a comment`, () => {
      // HEADER records carry no '#', so the outer loop walks them byte by byte
      // and their string literals are the one place it reliably meets quoted
      // text. An unterminated '/*' there used to take the whole DATA section
      // with it, turning a legal file into an empty model.
      const src = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('rev /* pending'),'2;1');",
        'ENDSEC;',
        'DATA;',
        "#1=IFCWALL('a');",
        'ENDSEC;',
        'END-ISO-10303-21;',
      ].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1]);
    });

    it(`${name}: a HEADER slash-star closed later in DATA does not eat the records between`, () => {
      // The nastier shape of the HEADER case, because it does not look broken.
      // An unterminated comment yields nothing and is obvious; a comment that
      // opens in a HEADER string and closes inside a later DATA string just
      // drops the records in between, leaves a non-empty result, and so is
      // accepted by callers that only check for emptiness.
      const src = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_NAME('plan /* draft.ifc','2024-01-01T00:00:00',(''),(''),'','','');",
        'ENDSEC;',
        'DATA;',
        "#1=IFCWALL('a');",
        "#2=IFCWALL('b');",
        "#3=IFCWALL('note */ done');",
        "#4=IFCWALL('d');",
        'ENDSEC;',
        'END-ISO-10303-21;',
      ].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1, 2, 3, 4]);
    });

    it(`${name}: a record-shaped token inside a HEADER string is not a record`, () => {
      const src = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('see #12=IFCWALL(x) in the old revision'),'2;1');",
        'ENDSEC;',
        'DATA;',
        "#1=IFCWALL('a');",
        'ENDSEC;',
        'END-ISO-10303-21;',
      ].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([1]);
    });

    it(`${name}: does not nest, because ISO 10303-21 comments do not`, () => {
      // The first `*/` closes the comment. Treating the inner `/*` as a new
      // level would swallow #2.
      const src = ['/* outer /* inner */', "#2=IFCWALL('b');"].join('\n');
      expect(scan(src).map((r) => r.expressId)).toEqual([2]);
    });
  }
});
