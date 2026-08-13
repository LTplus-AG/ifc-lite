/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2583: the world view dropped its model the moment anything invalidated it,
 * then took a debounce plus a GLB build plus a glTF load to put one back — the
 * building vanished from the map on every edit.
 *
 * The invariant that fixes it is an ordering one, so that is what is asserted:
 * the globe is never empty, and the old primitive is still released.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { swapCesiumModel } from './cesium-model-swap.js';

/** Records every operation and the collection's contents after each one. */
function fakeCollection() {
  const contents = new Set<string>();
  const ops: string[] = [];
  const sizes: number[] = [];
  return {
    contents,
    ops,
    sizes,
    add(p: string) { contents.add(p); ops.push(`add:${p}`); sizes.push(contents.size); return p; },
    remove(p: string) { const had = contents.delete(p); ops.push(`remove:${p}`); sizes.push(contents.size); return had; },
  };
}

describe('swapCesiumModel', () => {
  it('adds the replacement BEFORE dropping the old one', () => {
    const c = fakeCollection();
    c.add('old');
    c.ops.length = 0; c.sizes.length = 0;

    swapCesiumModel(c, 'old', 'new');

    assert.deepEqual(c.ops, ['add:new', 'remove:old'], 'remove-then-add would blank the globe');
  });

  it('never leaves the globe empty, at any point during the swap', () => {
    const c = fakeCollection();
    c.add('old');
    c.ops.length = 0; c.sizes.length = 0;

    swapCesiumModel(c, 'old', 'new');

    assert.ok(c.sizes.every((n) => n >= 1), `collection emptied mid-swap: ${c.sizes.join(',')}`);
  });

  it('releases the old primitive, so a rebuild does not leak a model', () => {
    const c = fakeCollection();
    c.add('old');

    swapCesiumModel(c, 'old', 'new');

    assert.deepEqual([...c.contents], ['new']);
  });

  it('just adds when there is nothing to replace (first load)', () => {
    const c = fakeCollection();

    swapCesiumModel(c, null, 'first');

    assert.deepEqual(c.ops, ['add:first']);
    assert.deepEqual([...c.contents], ['first']);
  });

  it('does not remove the model it just added when asked to replace itself', () => {
    // Defensive: a caller that passes the same reference for both must not end
    // up with an empty globe and a destroyed primitive.
    const c = fakeCollection();
    c.add('same');
    c.ops.length = 0;

    swapCesiumModel(c, 'same', 'same');

    assert.deepEqual([...c.contents], ['same']);
    assert.deepEqual(c.ops, ['add:same']);
  });
});
