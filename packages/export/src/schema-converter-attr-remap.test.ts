/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `splitTopLevelAttributes` used to carry its own top-level-comma scanner,
 * near-identical to `step-argument-parser.ts`'s `splitTopLevelArgs`
 * (LTplus-AG/ifc-lite#4125). It is now a thin wrapper over that shared
 * splitter. These tests pin: (1) the two functions agree on every input
 * `remapRenamedAttributesByName`'s real callers can produce, so the
 * consolidation changed no observable output; (2) the one input where they
 * legitimately differ (a trailing empty argument), which
 * `remapRenamedAttributesByName`'s fixed-arity IFCDOORTYPE/IFCWINDOWTYPE
 * callers never produce.
 */
import { describe, it, expect } from 'vitest';
import { splitTopLevelAttributes } from './schema-converter-attr-remap.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

describe('splitTopLevelAttributes delegates to the shared splitTopLevelArgs', () => {
  it('returns [] for an empty or whitespace-only list', () => {
    expect(splitTopLevelAttributes('')).toEqual([]);
    expect(splitTopLevelAttributes('   ')).toEqual([]);
  });

  it.each([
    // Real IfcDoorType/IfcWindowType attribute lists (see
    // schema-converter-door-window-type.test.ts) plus edge cases the old
    // local scanner had to handle: nested parens, quoted strings with an
    // embedded comma, and a doubled-quote escape.
    ["'1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag',$,.DOOR.,.SINGLE_SWING_LEFT.,.T.,$"],
    ["'guid',$,'Bridge 1',$,$,$,$,$"],
    ["'a, b',#1,(#2,#3),$"],
    ["'it''s escaped',#1,$"],
    ['#1,#2,#3'],
  ])('agrees with splitTopLevelArgs for %j', (input) => {
    expect(splitTopLevelAttributes(input)).toEqual(splitTopLevelArgs(input));
  });

  it('a trailing empty argument is dropped, matching splitTopLevelArgs (not the old local scanner, which kept it) — never reached by a fixed-arity IFCDOORTYPE/IFCWINDOWTYPE list', () => {
    expect(splitTopLevelAttributes('a,')).toEqual(['a']);
    expect(splitTopLevelAttributes('a,')).toEqual(splitTopLevelArgs('a,'));
  });
});
