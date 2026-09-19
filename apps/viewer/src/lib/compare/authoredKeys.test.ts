/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's duplicate-authored-key info (issue #4989): the DATA
 * shown when `resolveAuthoredKeys` refused to key two or more entities on
 * the same authored value (`duplicateAuthoredKeys`), falling both back to
 * GlobalId. `null` when there is nothing to say. Sentence assembly (the
 * translated text) is the component's job (`CompareKeyProperty.tsx`), not
 * this lib file's — see the doc comment on `duplicateAuthoredKeyInfo`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as authoredKeys from './authoredKeys.js';

// `import * as ns` + a typeof check before calling: `duplicateAuthoredKeyInfo`
// is a NEW export, so calling it directly would read INCONCLUSIVE under the
// test-revert oracle (a revert of the source change would make the import
// itself fail to resolve, not just the assertions below).
assert.equal(typeof authoredKeys.duplicateAuthoredKeyInfo, 'function');
const { duplicateAuthoredKeyInfo } = authoredKeys;

describe('duplicateAuthoredKeyInfo (#4989)', () => {
  it('is null for an empty map', () => {
    assert.equal(duplicateAuthoredKeyInfo(new Map()), null);
  });

  it('reports the count and the values for one collision', () => {
    const info = duplicateAuthoredKeyInfo(new Map([['A-100', [1, 2]]]));
    assert.deepEqual(info, { count: 1, shown: ['A-100'], truncated: false });
  });

  it('lists up to 5 values untruncated for three collisions', () => {
    const dup = new Map([
      ['A-1', [1, 2]],
      ['A-2', [3, 4]],
      ['A-3', [5, 6]],
    ]);
    const info = duplicateAuthoredKeyInfo(dup);
    assert.deepEqual(info, { count: 3, shown: ['A-1', 'A-2', 'A-3'], truncated: false });
  });

  it('caps the listed values at 5 and marks truncated for more', () => {
    const dup = new Map<string, number[]>();
    for (let i = 1; i <= 7; i++) dup.set(`V${i}`, [i, i + 100]);
    const info = duplicateAuthoredKeyInfo(dup);
    assert.deepEqual(info, { count: 7, shown: ['V1', 'V2', 'V3', 'V4', 'V5'], truncated: true });
  });
});
