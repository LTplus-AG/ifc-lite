/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `splitTopLevelAttributes` used to carry its own top-level-comma scanner,
 * near-identical to the validated STEP slot parser (LTplus-AG/ifc-lite#4125).
 * It is now a thin wrapper over that shared refusal boundary. These tests pin
 * the actual tokens, including a trailing empty slot, instead of comparing
 * one parser implementation with another copy.
 */
import { describe, it, expect } from 'vitest';
import { splitTopLevelAttributes } from './schema-converter-attr-remap.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

describe('splitTopLevelAttributes delegates to the validated slot splitter', () => {
  it('returns [] for an empty or whitespace-only list', () => {
    expect(splitTopLevelAttributes('')).toEqual([]);
    expect(splitTopLevelAttributes('   ')).toEqual([]);
  });

  it.each([
    // Real IfcDoorType/IfcWindowType attribute lists (see
    // schema-converter-door-window-type.test.ts) plus edge cases the old
    // local scanner had to handle: nested parens, quoted strings with an
    // embedded comma, and a doubled-quote escape.
    //
    // Expected tokens are authored by hand, not derived from
    // `splitTopLevelStepArguments` itself: `splitTopLevelAttributes` is a pure
    // delegate to the validated parser (see the export above), so asserting
    // one against the other would only ever confirm `f(x) === f(x)` — a
    // parser defect shared by both sides (e.g. mis-scanning the embedded
    // comma in `'a, b'`) would pass unnoticed.
    [
      "'1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag',$,.DOOR.,.SINGLE_SWING_LEFT.,.T.,$",
      [
        "'1mW6gHB0W7lxCAqIKVEzia'",
        '#2',
        "'Door Type'",
        '$',
        '$',
        '(#3)',
        '(#4)',
        "'tag'",
        '$',
        '.DOOR.',
        '.SINGLE_SWING_LEFT.',
        '.T.',
        '$',
      ],
    ],
    [
      "'guid',$,'Bridge 1',$,$,$,$,$",
      ["'guid'", '$', "'Bridge 1'", '$', '$', '$', '$', '$'],
    ],
    ["'a, b',#1,(#2,#3),$", ["'a, b'", '#1', '(#2,#3)', '$']],
    ["'it''s escaped',#1,$", ["'it''s escaped'", '#1', '$']],
    ['#1,#2,#3', ['#1', '#2', '#3']],
  ])('splits %j into the expected validated tokens', (input, expected) => {
    expect(splitTopLevelAttributes(input)).toEqual(expected);
    expect(splitTopLevelStepArguments(input)).toEqual(expected);
  });

  it('keeps an empty trailing slot position-addressable', () => {
    expect(splitTopLevelAttributes('a,')).toEqual(['a', '']);
  });

  it('refuses malformed slots instead of remapping values at shifted positions', () => {
    expect(splitTopLevelAttributes(`'g',"01,23"`)).toBeNull();
  });
});
