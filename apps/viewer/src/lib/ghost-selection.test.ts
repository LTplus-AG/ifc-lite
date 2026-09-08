/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scalar channel is the whole point of this helper: a plain viewport click
 * sets `selectedEntityId` and CLEARS `selectedEntityIds`, so a consumer reading
 * only the set fades the element the user just picked (#2591 review). The merge
 * previously lived inline in a hook, above the tested seam.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ghostExemptSelection } from './ghost-selection.js';

describe('ghostExemptSelection', () => {
  it('includes a scalar selection with no set — the plain-click case', () => {
    assert.deepEqual([...(ghostExemptSelection(42, new Set()) ?? [])], [42]);
    assert.deepEqual([...(ghostExemptSelection(42, null) ?? [])], [42]);
  });

  it('includes a multi-selection with no scalar', () => {
    assert.deepEqual([...(ghostExemptSelection(null, new Set([1, 2])) ?? [])].sort(), [1, 2]);
  });

  it('merges both channels rather than preferring one', () => {
    assert.deepEqual([...(ghostExemptSelection(3, new Set([1, 2])) ?? [])].sort(), [1, 2, 3]);
  });

  it('does not duplicate a scalar already present in the set', () => {
    assert.equal(ghostExemptSelection(1, new Set([1, 2]))?.size, 2);
  });

  it('is null when nothing is selected, so callers can skip the work', () => {
    assert.equal(ghostExemptSelection(null, null), null);
    assert.equal(ghostExemptSelection(null, new Set()), null);
    assert.equal(ghostExemptSelection(undefined, undefined), null);
  });

  it('treats express id 0 as a real selection, not as absent', () => {
    // 0 is falsy; a truthiness check here would silently drop it.
    assert.deepEqual([...(ghostExemptSelection(0, null) ?? [])], [0]);
  });

  it('does not alias the caller\'s set', () => {
    const ids = new Set([1]);
    const merged = ghostExemptSelection(2, ids);

    assert.equal(ids.size, 1, 'the store set must not gain the scalar');
    assert.equal(merged?.size, 2);
  });
});
