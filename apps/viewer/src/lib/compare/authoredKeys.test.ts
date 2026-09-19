/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's duplicate-authored-key note (issue #4989): the sentence
 * shown when `resolveAuthoredKeys` refused to key two or more entities on the
 * same authored value (`duplicateAuthoredKeys`), falling both back to
 * GlobalId. `null` when there is nothing to say.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as authoredKeys from './authoredKeys.js';

// `import * as ns` + a typeof check before calling: `duplicateAuthoredKeyNote`
// is a NEW export, so calling it directly would read INCONCLUSIVE under the
// test-revert oracle (a revert of the source change would make the import
// itself fail to resolve, not just the assertions below).
assert.equal(typeof authoredKeys.duplicateAuthoredKeyNote, 'function');
const { duplicateAuthoredKeyNote } = authoredKeys;

describe('duplicateAuthoredKeyNote (#4989)', () => {
  it('is null for an empty map', () => {
    assert.equal(duplicateAuthoredKeyNote(new Map()), null);
  });

  it('lists every value up to 5, singular wording for one', () => {
    const note = duplicateAuthoredKeyNote(new Map([['A-100', [1, 2]]]));
    assert.equal(note, '1 authored value shared by several elements fell back to GlobalId: A-100');
  });

  it('lists up to 5 values and pluralizes for more than one', () => {
    const dup = new Map([
      ['A-1', [1, 2]],
      ['A-2', [3, 4]],
      ['A-3', [5, 6]],
    ]);
    const note = duplicateAuthoredKeyNote(dup);
    assert.equal(note, '3 authored values shared by several elements fell back to GlobalId: A-1, A-2, A-3');
  });

  it('caps the listed values at 5 and appends an ellipsis for more', () => {
    const dup = new Map<string, number[]>();
    for (let i = 1; i <= 7; i++) dup.set(`V${i}`, [i, i + 100]);
    const note = duplicateAuthoredKeyNote(dup);
    assert.equal(note, '7 authored values shared by several elements fell back to GlobalId: V1, V2, V3, V4, V5, …');
  });
});
