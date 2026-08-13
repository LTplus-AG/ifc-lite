/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { replaceStepArgument, splitTopLevelStepArguments } from './step-argument-parser.js';

describe('replaceStepArgument slot validation', () => {
  const LINE = "#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#30),$,$,$,.STANDARD.);";

  it('replaces the requested slot and leaves every other token byte-identical', () => {
    const out = replaceStepArgument(LINE, 5, '(#33)');
    expect(out).toBe("#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1',$,$,(#33),$,$,$,.STANDARD.);");
  });

  it('returns null for a slot past the end rather than a silently unchanged line', () => {
    expect(replaceStepArgument(LINE, 99, '(#33)')).toBeNull();
  });

  // A negative or fractional index would assign a NAMED PROPERTY on the array
  // instead of an element; `join` skips it, so the function would hand back the
  // line unchanged but NON-NULL. Callers read non-null as "the replacement
  // happened" -- `rewriteTypeOwnedPsetLine` turns it into `repointed: true` --
  // so an unchanged non-null is a silent false success, the same shape as the
  // drop this module's caller was fixed for. Unreachable through the exporter
  // today (the only slot is a constant), pinned because the contract is public.
  for (const slot of [-1, -5, 1.5, Number.NaN]) {
    it(`returns null for the invalid slot ${String(slot)}`, () => {
      expect(replaceStepArgument(LINE, slot, '(#33)')).toBeNull();
    });
  }
});

/**
 * github.com/LTplus-AG/ifc-lite/issues/2470, second half: the helper's failure
 * SIGNALLING, one level below the null contract above.
 *
 * `splitTopLevelStepArguments` tracked quote state and paren depth to find the
 * top-level commas and then ignored where that scan ended up. Text that never
 * left a string, or never closed a nested list, still produced parts — parts
 * whose boundaries are wherever the scanner stopped rather than the record's
 * slots. `replaceStepArgument`'s regex pins only the two ENDS of the record, so
 * such a line reaches the split, gets a slot written by index, and comes back
 * NON-NULL: a success it did not achieve, and a corrupted line where #2469 had
 * a dropped one.
 *
 * Each malformed case below returned a string before the fix — the mutation
 * check for this block is to delete one rejection and watch its case go from
 * `null` to a plausible-looking rewritten line. The VALID block underneath is
 * the bounding control: rejecting everything would pass the block above alone,
 * and would take the type-object repoint down with it (every real IfcWallType
 * line goes through here).
 */
describe('replaceStepArgument rejects an argument list it could not scan', () => {
  it('returns null for an unterminated quoted string', () => {
    // The quote before `WT1` never closes, so everything after it is one
    // "string" and the remaining commas are invisible to the scan.
    expect(
      replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1,$,$,(#30),$);", 1, "'X'"),
    ).toBeNull();
  });

  it('returns null for an unbalanced nested list', () => {
    // `(#30` never closes: the scan ends at depth 1 having swallowed every
    // comma after it.
    expect(
      replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#30,$,$,$,.STANDARD.);", 1, "'X'"),
    ).toBeNull();
  });

  it('returns null for a stray closing paren the scan recovers from', () => {
    // Depth goes NEGATIVE at the paren after `'a'` and back to zero at the one
    // before `'b'`, so the FINAL state is balanced and a final-state check alone
    // calls this well-formed. It is not: every comma while depth was negative
    // was swallowed, so the parts that come out are `["'a'),('b'", '$', '$',
    // '$', '$']` and writing slot 1 lands on an argument the record does not
    // have — the corrupted-output case, returned as a success.
    expect(replaceStepArgument("#7=IFCFOO('a'),('b',$,$,$,$);", 1, "'X'")).toBeNull();
  });

  it('writes the slot on a line with an EMPTY one rather than refusing it', () => {
    // Invalid STEP, and deliberately still accepted: an empty argument is ONE
    // part, exactly as the entity parser counts it, so slot 5 is still slot 5.
    // Refusing it is what would do damage — the parser resolves
    // `HasPropertySets` on such a line, so by the time the repoint runs the
    // export has already withheld the property set's own lines, and a refused
    // repoint leaves the record pointing at an entity that is no longer in the
    // file. The exporter-level case is `a line the parser accepted keeps its
    // slot 5 in step with the psets it dropped` in `slot5-caller-audit.test.ts`.
    expect(replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',,'WT1',$,$,(#30));", 5, '(#33)'))
      .toBe("#5=IFCWALLTYPE('0OSuGGYU',,'WT1',$,$,(#33));");
    expect(replaceStepArgument("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#30),);", 5, '(#33)'))
      .toBe("#5=IFCWALLTYPE('0OSuGGYU',$,'WT1',$,$,(#33),);");
  });

  it('returns null for a record with no arguments at all', () => {
    // Not an empty SLOT — a record that has no slots, so slot 0 is still past
    // the end and the answer is the same null the bounds check gives.
    expect(replaceStepArgument('#5=IFCWALLTYPE();', 0, '(#33)')).toBeNull();
  });
});

describe('splitTopLevelStepArguments contract', () => {
  it('splits a well-formed list and keeps each token verbatim', () => {
    expect(splitTopLevelStepArguments("'a',$,(#1,#2),.T.")).toEqual(["'a'", '$', '(#1,#2)', '.T.']);
  });

  it('reads an EMPTY argument list as no arguments, not as a malformed one', () => {
    // `#1=IFCFOO();` is a record with no slots — different from `(,)`, which is
    // a record with a slot nothing was written into. Callers that ask for a
    // slot get their answer from the bounds check instead.
    expect(splitTopLevelStepArguments('')).toEqual([]);
    expect(splitTopLevelStepArguments('   ')).toEqual([]);
  });

  it('returns null, not partial parts, for each way the scan can end badly', () => {
    expect(splitTopLevelStepArguments("'a',$,'unterminated")).toBeNull();
    expect(splitTopLevelStepArguments("'a',(#1,#2")).toBeNull();
    expect(splitTopLevelStepArguments("'a'),('b',$")).toBeNull();
  });

  it('keeps an empty slot as a slot, so every index after it still lines up', () => {
    // The only malformity that does NOT shift the parts: one empty argument is
    // one part, which is how the entity parser reads it too.
    expect(splitTopLevelStepArguments("'a',,$")).toEqual(["'a'", '', '$']);
    expect(splitTopLevelStepArguments("'a',$,")).toEqual(["'a'", '$', '']);
  });
});

describe('replaceStepArgument still accepts every well-formed list', () => {
  it('keeps a comma inside a quoted string out of the split', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',$,'WT1, exterior',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',$,'WT1, exterior',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });

  it('keeps a doubled-quote escape and the parens inside a string intact', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',$,'O''Brien (west),$',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',$,'O''Brien (west),$',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });

  it('keeps a nested list argument intact', () => {
    const line = '#7=IFCFOO((1.,2.,3.),$,(#1,#2),$,$,(#30));';
    expect(replaceStepArgument(line, 5, '(#33)')).toBe('#7=IFCFOO((1.,2.,3.),$,(#1,#2),$,$,(#33));');
  });

  it('keeps a multi-line record intact', () => {
    const line = "#5=IFCWALLTYPE('0OSuGGYU',\n$,\n'WT1',$,$,(#30),$,$,$,.STANDARD.);";
    expect(replaceStepArgument(line, 5, '(#33)')).toBe(
      "#5=IFCWALLTYPE('0OSuGGYU',\n$,\n'WT1',$,$,(#33),$,$,$,.STANDARD.);",
    );
  });
});
