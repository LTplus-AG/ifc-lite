/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: after #7540 the entity scanners read the PAGE directive's apostrophe
 * operand (`'Para \S\' 5'`) as string text, but the CLI's own STEP text
 * walkers still ended the literal at it. Each one below now takes the shared
 * rule (`stepStringLiteralEnd` in `@ifc-lite/encoding`), pinned over the
 * cross-language vectors: record framing, argument splits and reference
 * discovery are right after the literal, and `#9` inside string text is never
 * a reference.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { forwardClosure, parseStep } from './extract-entities.js';
import { splitTopLevelStepArgs } from './step-args.js';
import { refsOutsideStrings, splitTopLevelArgs } from './subset-relations.js';
import { collectDanglingReferences } from './validate.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

const TEXT_WITH_REF = "'see #9'";
const body = (literal: string): string => `'guid',$,${literal},${TEXT_WITH_REF},#5,(#6,#7)`;
const file = (literal: string): string => [
  'ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#10=IFCWALL(${body(literal)});`,
  '#11=IFCPOINT(#10);',
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

describe('CLI STEP walkers over PAGE-operand literals (#7589)', () => {
  for (const { name, literal } of vectors) {
    describe(name, () => {
      it('parseStep frames the record and its successor', () => {
        const parsed = parseStep(file(literal));
        expect([...parsed.instances.keys()]).toEqual([10, 11]);
        expect(parsed.instances.get(10)?.body).toBe(body(literal));
        expect(parsed.instances.get(11)?.body).toBe('#10');
      });

      it('finds the real references and not the `#9` in string text', () => {
        expect(refsOutsideStrings(body(literal))).toEqual([5, 6, 7]);
        const parsed = parseStep(file(literal));
        const closure = new Set<number>();
        forwardClosure([11], parsed, closure);
        expect([...closure].sort((a, b) => a - b)).toEqual([10, 11]);
      });

      it('splits the arguments at the right commas', () => {
        const expected = ["'guid'", '$', literal, TEXT_WITH_REF, '#5', '(#6,#7)'];
        expect(splitTopLevelArgs(body(literal))).toEqual(expected);
        expect(splitTopLevelStepArgs(body(literal))).toEqual(expected);
      });
    });
  }

  it('reports a literal that never closes instead of guessing an argument split', () => {
    expect(splitTopLevelArgs("'guid',$,'Para \\S\\'")).toBeNull();
    expect(splitTopLevelStepArgs("'guid',$,'Para \\S\\'")).toBeNull();
  });

  it('collectDanglingReferences reports the missing ref after the literal, not the text inside it', async () => {
    const text = [
      'ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
      "#5=IFCWALL('0Wall_GUID_00000001',$,'Para \\S\\' 5','Art \\S\\' #77',#9999,$,$,$,$);",
      "#6=IFCWALL('0Wall_GUID_00000002',$,'Next',$,$,$,$,$,$);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const store = await new IfcParser().parseColumnar(buffer);
    expect(collectDanglingReferences(store)).toEqual([
      { entityId: 5, entityType: 'IFCWALL', attributeIndex: 4, target: 9999 },
    ]);
  });
});
