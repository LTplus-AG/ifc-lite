/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: the STEP subset walkers end a string literal by the shared rule
 * (`stepStringLiteralEnd` in `@ifc-lite/encoding`), pinned over the
 * cross-language PAGE-directive vectors: record framing, argument splits and
 * reference discovery are right after the literal, and `#9` inside string text
 * is never a reference. Moved here from the CLI with the walkers themselves.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forwardClosure, parseStep } from './step-subset.js';
import { refsOutsideStrings, splitTopLevelArgs } from './step-subset-relations.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

const TEXT_WITH_REF = "'see #9'";
const body = (literal: string): string => `'guid',$,${literal},${TEXT_WITH_REF},#5,(#6,#7)`;
const file = (literal: string): string => [
  'ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#10=IFCWALL(${body(literal)});`,
  '#11=IFCPOINT(#10);',
  '#5=IFCDIRECTION((1.,0.,0.));', '#6=IFCDIRECTION((0.,1.,0.));', '#7=IFCDIRECTION((0.,0.,1.));',
  // Named only inside string text: a closure that reads it as a reference pulls it in.
  '#9=IFCDIRECTION((1.,1.,0.));',
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

describe('STEP subset walkers over PAGE-operand literals (#7589)', () => {
  for (const { name, literal } of vectors) {
    describe(name, () => {
      it('parseStep frames the record and its successor', () => {
        const parsed = parseStep(file(literal));
        expect([...parsed.instances.keys()]).toEqual([10, 11, 5, 6, 7, 9]);
        expect(parsed.instances.get(10)?.body).toBe(body(literal));
        expect(parsed.instances.get(11)?.body).toBe('#10');
      });

      it('finds the real references and not the `#9` in string text', () => {
        expect(refsOutsideStrings(body(literal))).toEqual([5, 6, 7]);
        const parsed = parseStep(file(literal));
        const closure = new Set<number>();
        forwardClosure([11], parsed, closure);
        // The real references are followed, the `#9` in string text is not.
        expect([...closure].sort((a, b) => a - b)).toEqual([5, 6, 7, 10, 11]);
      });

      it('splits the arguments at the right commas', () => {
        const expected = ["'guid'", '$', literal, TEXT_WITH_REF, '#5', '(#6,#7)'];
        expect(splitTopLevelArgs(body(literal))).toEqual(expected);
      });
    });
  }

  it('reports a literal that never closes instead of guessing an argument split', () => {
    expect(splitTopLevelArgs("'guid',$,'Para \\S\\'")).toBeNull();
  });
});
