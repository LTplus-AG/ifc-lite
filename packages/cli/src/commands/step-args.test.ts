/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { splitTopLevelStepArgs } from './step-args.js';

describe('splitTopLevelStepArgs', () => {
  describe('lists it accepts', () => {
    it.each([
      ['simple comma-separated values', "'abc',123,$,.T.", ["'abc'", '123', '$', '.T.']],
      ['a nested list', "'hello',(1,2,3),$", ["'hello'", '(1,2,3)', '$']],
      ['deeply nested lists', '#1,IFCWALL((1,(2,3)),4),#5', ['#1', 'IFCWALL((1,(2,3)),4)', '#5']],
      ['a comma inside a string', "'hello, world',42", ["'hello, world'", '42']],
      ['a paren inside a string', "'a (b) c',42", ["'a (b) c'", '42']],
      ['a doubled-quote escape', "'it''s a test',99", ["'it''s a test'", '99']],
      ['an escaped quote next to the terminator', "'ends with''',7", ["'ends with'''", '7']],
      ['an empty string literal', "'',$", ["''", '$']],
      ['STEP null and derived markers', '$,$,*', ['$', '$', '*']],
      ['entity references', '#1,#2,#3', ['#1', '#2', '#3']],
      ['a single value', '42', ['42']],
      ['no arguments at all', '', []],
      // Invalid STEP, deliberately accepted: an empty slot is ONE part, so
      // every later index still names the attribute it is meant to. Refusing
      // it would refuse a rewrite that would have been correct.
      ['an empty interior slot', 'a,,b', ['a', '', 'b']],
      // The positive controls for the refusals below: the same shapes, written
      // correctly. A validator that refused these would break `mutate` on
      // well-formed files, which is the more expensive failure.
      [
        'a typed value holding a string',
        "'guid',$,IFCLABEL('a'),$",
        ["'guid'", '$', "IFCLABEL('a')", '$'],
      ],
      [
        'adjacent string lists with their apostrophes doubled',
        "'id','Smith','John',('D''Arcy'),('O''Neill'),$,$,$",
        ["'id'", "'Smith'", "'John'", "('D''Arcy')", "('O''Neill')", '$', '$', '$'],
      ],
      // The positive controls for the comment refusals. `/` breaks a bare run,
      // so these pin that it does NOT reach inside a string: storey and family
      // names carry slashes constantly ('Level 1/2', 'M_Wall/Basic'), and
      // refusing them would break `mutate` on ordinary files.
      [
        'a slash inside a string',
        "'guid',$,'Level 1/2',$",
        ["'guid'", '$', "'Level 1/2'", '$'],
      ],
      [
        'a comment opener inside a string',
        "'guid',$,'50% /* not a comment',$",
        ["'guid'", '$', "'50% /* not a comment'", '$'],
      ],
      // #4163's multi-line work feeds this a raw, un-pre-split `argsText`, so a
      // record wrapped across a line, with the comma correctly kept BEFORE the
      // break, must still split into the right number of parts. This is the
      // well-formed counterpart to the malformed `$\n$` case below: same shape,
      // comma present, and it must be ACCEPTED with the correct count (9, not
      // 8) rather than refused as collateral damage from widening the
      // whitespace sets.
      [
        'a bare token list wrapped across a newline with the comma kept',
        "'guid',$,'Old',$,\n$,$,$,$,.NOTDEFINED.",
        ["'guid'", '$', "'Old'", '$', '\n$', '$', '$', '$', '.NOTDEFINED.'],
      ],
    ])('splits %s', (_label, input, expected) => {
      expect(splitTopLevelStepArgs(input)).toEqual(expected);
    });

    it('keeps a `#` inside a string out of the reference syntax', () => {
      // A Name of "Wall #3, north" is the shape that makes a naive splitter
      // look right and be wrong: the comma is inside the string and the `#`
      // is not a reference.
      expect(splitTopLevelStepArgs("'guid',$,'Wall #3, north',$")).toEqual([
        "'guid'",
        '$',
        "'Wall #3, north'",
        '$',
      ]);
    });

    it('is byte-exact under join, so an untouched record round-trips', () => {
      // The whole point of not trimming. `applyAttributeMutations` rebuilds the
      // line as `prefix + parts.join(',') + suffix`, so any normalisation here
      // would rewrite records nobody asked to change.
      for (const input of [
        "'2aG1gNarLHm9Qs6Q3z97P1',#2,'Wall-001','An external wall',$,$,$,'TAG',.NOTDEFINED.",
        "'guid', $ , 'padded' ,(1., 2., 3.)",
        "'it''s',(#1,#2),$",
        "'a (b) c','d,e'",
        'a,,b',
        '42',
        '',
      ]) {
        expect(splitTopLevelStepArgs(input)!.join(',')).toBe(input);
      }
    });
  });

  describe('lists it refuses', () => {
    it.each([
      // The #4125 reproduction, reduced to its argument list. `step-args.ts`'s
      // header has the walk-through of why this is 4 parts for 9 attributes.
      ['an undoubled apostrophe that leaves the scan mid-string', "'guid',$,'John's wall',$,$,$,$,'A's',.NOTDEFINED."],
      ['an unterminated string', "'guid',$,'never closed"],
      ['a quote opened by the last character', "'guid',$,'"],
      // Both of these are refused by the per-part check as well as by the
      // structural one their label names; see the paren-pair test below.
      ['a stray closing paren', "'guid',$,'N'),$,$"],
      ['a stray closing paren that climbs back to zero', "'guid'),(  $,$"],
      ['an unclosed nested list', "'guid',(1,2,3"],
      ['a truncated record prefix', "'guid',$,$,$,(#2,#3"],
      // The same mis-scan one level down, which checking only the top level
      // cannot see: the phantom string swallows `),$,IFCLABEL(` whole, so the
      // parens still balance and every part is a keyword applied to one list.
      // Nine attributes read as seven, with the wrong slots from index 2 on.
      [
        'a phantom string that swallows a paren pair, leaving the depth balanced',
        "'1BBBBBBBBBBBBBBBBBBBBB',$,IFCLABEL('a's'),$,IFCLABEL('b's'),$,$,'T',.NOTDEFINED.",
      ],
      // The same shape on a real entity: IfcPerson declares MiddleNames and
      // PrefixTitles as adjacent lists of strings, so eight attributes read as
      // seven. IfcPropertyTableValue's DefiningValues/DefinedValues do it too.
      [
        'undoubled apostrophes in two adjacent string lists (the IfcPerson shape)',
        "'id','Smith','John',('D'Arcy'),('O'Neill'),$,$,$",
      ],
      // Here the swallow eats the only top-level comma, so this arrives as ONE
      // part and nothing about the part's outline is wrong. Only the inside of
      // the list gives it away.
      ['two typed values run together into a single part', "IFCLABEL('a's'),IFCLABEL('b's')"],
      // A STEP block comment, named as a cause in the error `mutate` throws.
      // It is refused rather than understood: no copy of this rule reads one,
      // and a comment sits where a token or a separator belongs, so accepting
      // it adds a phantom slot and shifts every attribute after it.
      //
      // All five shapes are pinned because the whitespace in the first is what
      // used to do the refusing, and only the first has any. The rest were
      // ACCEPTED, with the splits named below, until `/` broke a bare run.
      ['a STEP block comment with spaces around it', '$,/* renamed */ $'],
      // Was ['$', '/*renamed*/', '$']: three slots for two attributes, the
      // same phantom-slot shift as the rest of #4125. Reproduced end to end
      // against the built CLI; see `mutate.test.ts`.
      ['a STEP block comment carrying no whitespace at all', '$,/*renamed*/,$'],
      // Was one token, so a record ending in a commented-out attribute kept
      // its slot count and passed.
      ['a STEP block comment stuck to the end of a token', '$/*x*/'],
      // Was ["'guid'", '/*a', 'b*/', "'Name'"]: the comma inside the comment
      // splits it in two, so four slots for three attributes.
      ['a STEP block comment holding a comma', "'guid',/*a,b*/,'Name'"],
      // The OPENER is what breaks the run, so a comment that never closes is
      // refused for the same reason rather than by luck.
      ['an unterminated STEP block comment', "'guid',/*unclosed,$"],
      // The #4163 defect this file's header names by name: two bare tokens
      // (`$` and `$`) separated by a raw newline with NO comma between them.
      // Before `\n`/`\r`/`\x0b`/`\x0c` joined `isTokenBreak` and
      // `countWhitespace`, a bare run spanned the newline silently and this
      // came back as 8 accepted parts for 9 attributes (measured against the
      // pre-fix source: `["'guid'","$","'Old'","$\n$","$","$","$",".NOTDEFINED."]`,
      // non-null, i.e. treated as READABLE) rather than refused — the same
      // phantom-slot shift as the rest of #4125/#4163, just triggered by a line
      // wrap instead of a phantom string. Every attribute past the merged pair
      // then mutates into the wrong slot while the CLI reports success.
      [
        'a bare token split across a raw newline with the comma dropped',
        "'guid',$,'Old',$\n$,$,$,$,.NOTDEFINED.",
      ],
    ])('refuses %s', (_label, input) => {
      expect(splitTopLevelStepArgs(input)).toBeNull();
    });

    it('refuses a paren pair in the wrong order, though the counts balance', () => {
      // ')...(' has as many of each as '(...)', so a scanner that only checks
      // the FINAL depth calls it well-formed and reads every comma between the
      // two as nested. The negative-depth check fires first here, but it is not
      // what makes this safe: with that check deleted the scan yields a part
      // "a)" that is not one token, and the per-part check refuses it anyway.
      const input = "a),b,(c";
      expect(input.split('(').length).toBe(input.split(')').length);
      expect(splitTopLevelStepArgs(input)).toBeNull();
    });
  });
});
