/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { namesAnyRecord, referencesAnyExpressId } from './step-ref-scan.js';

describe('referencesAnyExpressId', () => {
  it('finds a bare reference', () => {
    expect(referencesAnyExpressId("'guid',#209,'Name'", new Set([209]))).toBe(true);
  });

  it('finds a reference nested inside a list', () => {
    expect(referencesAnyExpressId('$,(#327,#329),((96.))', new Set([329]))).toBe(true);
  });

  it('is false when no id in the set is referenced', () => {
    expect(referencesAnyExpressId("'guid',#209,'Name'", new Set([326]))).toBe(false);
  });

  it('is false for an empty id set (no scan needed)', () => {
    expect(referencesAnyExpressId('#1,#2,#3', new Set())).toBe(false);
  });

  it('ignores a "#digits" pattern inside a quoted string', () => {
    // A Name value that happens to contain a hash-number must not be read
    // as an entity reference — #4206's withholding fix depends on this: a
    // structural member literally named "Beam #326" must not force itself
    // to a proxy just because #326 is a withheld express id elsewhere.
    expect(referencesAnyExpressId("'Beam #326',$,$", new Set([326]))).toBe(false);
  });

  it('still finds a real reference after a quoted string containing a hash-number', () => {
    expect(referencesAnyExpressId("'Beam #999',#326,$", new Set([326]))).toBe(true);
  });

  it('handles a doubled single-quote (STEP string escape) without losing string state', () => {
    // 'It''s #326' is ONE string value containing a literal apostrophe;
    // naive quote toggling would flip out of the string early and then
    // read the trailing #326 as a real reference.
    expect(referencesAnyExpressId("'It''s #326',$", new Set([326]))).toBe(false);
  });

  it('ignores a hash-number inside a /* ... */ comment', () => {
    expect(referencesAnyExpressId('$/* was #326 */,#1', new Set([326]))).toBe(false);
  });
});

describe('namesAnyRecord', () => {
  it('finds a reference past a string that ends in a \\S\\ directive operand', () => {
    // The quote after `\S\` is the directive's operand, and the next one closes the string (#10915).
    expect(namesAnyRecord("IFCPROPERTYSINGLEVALUE('Eastings','survey \\S\\'',IFCLENGTHMEASURE(2600100.),#3)")).toBe(true);
  });

  it('passes over a hash-number inside a string or comment', () => {
    expect(namesAnyRecord("IFCPROPERTYSINGLEVALUE('Eastings','survey #1',IFCLENGTHMEASURE(2600100.),$) /* #2 */")).toBe(false);
  });
});
