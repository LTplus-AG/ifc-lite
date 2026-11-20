/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A STEP comment is copied as it is and never opens a string, so the references after it are remapped (#10968). */

import { describe, expect, it } from 'vitest';
import { remapEntityText } from './merged-remap.js';

const NO_REMAP = new Map<number, number>();

describe('remapEntityText and STEP comments (#10968)', () => {
  it('remaps the references after a comment that holds an apostrophe', () => {
    expect(remapEntityText("#5=IFCWALL(/* it's */ #3,#4);", 100, NO_REMAP)).toBe("#105=IFCWALL(/* it's */ #103,#104);");
  });

  it('leaves a reference inside a comment as written', () => {
    expect(remapEntityText('#5=IFCWALL(/* was #3 */ #3,$);', 100, NO_REMAP)).toBe('#105=IFCWALL(/* was #3 */ #103,$);');
  });

  it('reads a comment opener inside a string as text', () => {
    expect(remapEntityText("#5=IFCWALL('a /* b',#3);", 100, new Map([[3, 7]]))).toBe("#105=IFCWALL('a /* b',#7);");
  });
});
