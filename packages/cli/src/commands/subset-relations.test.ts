/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { planSpatialRelations, splitTopLevelArgs, type StepRecord } from './subset-relations.js';

/**
 * #4227: `@ifc-lite/export`'s `step-argument-parser.ts` had two top-level STEP
 * argument splitters, and only one of them (`splitTopLevelStepArguments`)
 * skipped `/* ... *​/` comments atomically before reading commas as argument
 * boundaries. This module's own `splitTopLevelArgs` — a documented near-twin
 * of that same export-side function, copied rather than imported because
 * `@ifc-lite/export`'s `exports` map exposes only `.` — carried the identical
 * gap: a third, independently-drifted copy of the same missing logic. Fixed
 * by giving it its own local copy of `skipStepComment` (same reason it cannot
 * import `@ifc-lite/export`'s).
 */
describe('splitTopLevelArgs skips comment content in the outer scan (#4227)', () => {
  it('does not read a comma inside a comment as an argument boundary', () => {
    expect(splitTopLevelArgs("'guid',$,$,$,#1,/* void, comment */#5")).toEqual([
      "'guid'",
      '$',
      '$',
      '$',
      '#1',
      '/* void, comment */#5',
    ]);
  });

  it('a commented comma inside a NESTED list still resolves to the right slot boundaries', () => {
    expect(splitTopLevelArgs('$,(#2,/* c, with a comma */#3),#1')).toEqual([
      '$',
      '(#2,/* c, with a comma */#3)',
      '#1',
    ]);
  });

  it('a comment containing an apostrophe (odd quote count) does not flip string-scan state', () => {
    // An undoubled `'` inside a comment must not be read as opening a string
    // -- if it were, the comma in the next real argument would be swallowed.
    expect(splitTopLevelArgs("$,/* it's a void */#5,$")).toEqual(['$', "/* it's a void */#5", '$']);
  });

  it('a comment before the argument list even starts is untouched (no regression)', () => {
    expect(splitTopLevelArgs("'guid',$,$,$,#1,#5")).toEqual(["'guid'", '$', '$', '$', '#1', '#5']);
  });

  it('a top-level comma glued directly to the closing "*/" is still a boundary', () => {
    // skipStepComment must stop exactly at `*/` (`end + 2`), not one char past
    // it. Consuming an extra char would swallow a comma with zero whitespace
    // after the comment, merging the next argument into this one.
    expect(splitTopLevelArgs('$,/* c */,#5')).toEqual(['$', '/* c */', '#5']);
  });

  it('an unterminated comment consumes to end-of-text rather than corrupting the split', () => {
    // No closing `*/`: skipStepComment's own contract is "skip to end", so the
    // whole remainder is one part, not rejected and not split on any comma
    // that happens to sit inside it.
    expect(splitTopLevelArgs('#1,/* never closes, has a comma')).toEqual([
      '#1',
      '/* never closes, has a comma',
    ]);
  });

  it('both directions still hold: #id inside a plain string stays inert', () => {
    expect(splitTopLevelArgs("'#not,a,ref',#5")).toEqual(["'#not,a,ref'", '#5']);
  });

  it('both directions still hold: doubled-quote escapes do not end the string early', () => {
    expect(splitTopLevelArgs("'it''s, a wall',#5")).toEqual(["'it''s, a wall'", '#5']);
  });

  it('both directions still hold: nested lists still split correctly with no comment present', () => {
    expect(splitTopLevelArgs('(#2,#3),#1')).toEqual(['(#2,#3)', '#1']);
  });

  it('both directions still hold: multi-line text is unaffected', () => {
    expect(splitTopLevelArgs("'a',\n$,\n(#30)")).toEqual(["'a'", '$', '(#30)']);
  });

  it('both directions still hold: $ and * arguments pass through unchanged', () => {
    expect(splitTopLevelArgs('$,*,#5')).toEqual(['$', '*', '#5']);
  });

  it('both directions still hold: an unterminated string is still rejected', () => {
    expect(splitTopLevelArgs("'unterminated,#5")).toBeNull();
  });

  it('both directions still hold: an unbalanced list is still rejected', () => {
    expect(splitTopLevelArgs('(#2,#3,#1')).toBeNull();
  });

  it('both directions still hold: a stray closing paren is still rejected', () => {
    expect(splitTopLevelArgs('#1),#5')).toBeNull();
  });
});

/**
 * End-to-end: the same comment-corruption shape, through `planSpatialRelations`
 * — the actual write path `extract-entities.ts` calls. Mirrors #4227's own
 * "hidden reference leaks into written IFC" demonstration, but for this
 * module's failure mode: a comment-shifted six-attribute check falls back to
 * keep-whole-or-drop-whole and DROPS a containment relation that should have
 * survived with its hidden member stripped — the orphaned-storey symptom
 * (#4126) this module exists to prevent, reproduced by a different route.
 */
describe('planSpatialRelations survives a comment inside a relation record (#4227)', () => {
  it('strips a hidden RelatedElements member even when an earlier slot holds a commented comma', () => {
    const body =
      "'22$cx1uZzL8xftBk4$O_z','',/* hidden note, with comma */'Storey',$,(#10,#20,#30),#1";
    const inst: StepRecord = {
      id: 99,
      type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
      body,
      full: `#99=IFCRELCONTAINEDINSPATIALSTRUCTURE(${body});`,
    };
    // #20 is a hidden product: not in `keep`, must not survive into the
    // rewritten RelatedElements SET.
    const keep = new Set([10, 30, 1]);

    const plan = planSpatialRelations([inst], keep);

    expect(plan.add).toEqual([99]);
    expect(plan.rewritten.get(99)).toBe(
      "#99=IFCRELCONTAINEDINSPATIALSTRUCTURE('22$cx1uZzL8xftBk4$O_z','',/* hidden note, with comma */'Storey',$,(#10,#30),#1);",
    );
  });
});
