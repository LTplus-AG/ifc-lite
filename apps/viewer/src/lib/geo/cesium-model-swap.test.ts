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

/** A `whenReady` the test controls, so the pending window is observable. */
function deferredReady() {
  let release!: () => void;
  let reject!: (e: unknown) => void;
  const gate = new Promise<void>((res, rej) => { release = res; reject = rej; });
  return { whenReady: () => gate, release, reject };
}

const readyNow = async () => {};

describe('swapCesiumModel', () => {
  it('adds the replacement BEFORE dropping the old one', async () => {
    const c = fakeCollection();
    c.add('old');
    c.ops.length = 0; c.sizes.length = 0;

    await swapCesiumModel(c, 'old', 'new', readyNow);

    assert.deepEqual(c.ops, ['add:new', 'remove:old'], 'remove-then-add would blank the globe');
  });

  it('keeps the OLD model on the globe until the new one can draw', async () => {
    // The heart of #2583's second half: `fromGltfAsync` resolving is not the
    // same as the model being renderable. Dropping the old one at construction
    // time swaps a drawable primitive for a blank one.
    const c = fakeCollection();
    c.add('old');
    const gate = deferredReady();

    const swap = swapCesiumModel(c, 'old', 'new', gate.whenReady);
    await Promise.resolve();

    assert.deepEqual([...c.contents].sort(), ['new', 'old'], 'old must still be drawing');
    gate.release();
    await swap;
    assert.deepEqual([...c.contents], ['new']);
  });

  it('never leaves the globe empty, at any point during the swap', async () => {
    const c = fakeCollection();
    c.add('old');
    c.ops.length = 0; c.sizes.length = 0;

    await swapCesiumModel(c, 'old', 'new', readyNow);

    assert.ok(c.sizes.every((n) => n >= 1), `collection emptied mid-swap: ${c.sizes.join(',')}`);
  });

  it('releases the old primitive, so a rebuild does not leak a model', async () => {
    const c = fakeCollection();
    c.add('old');

    await swapCesiumModel(c, 'old', 'new', readyNow);

    assert.deepEqual([...c.contents], ['new']);
  });

  it('still drops the old model when the new one never reports ready', async () => {
    // Otherwise a model that fails to become renderable strands its
    // predecessor on the globe for the rest of the session.
    const c = fakeCollection();
    c.add('old');
    const gate = deferredReady();

    const swap = swapCesiumModel(c, 'old', 'new', gate.whenReady);
    gate.reject(new Error('never became ready'));
    await swap;

    assert.deepEqual([...c.contents], ['new']);
  });

  it('just adds when there is nothing to replace (first load)', async () => {
    const c = fakeCollection();

    await swapCesiumModel(c, null, 'first', readyNow);

    assert.deepEqual(c.ops, ['add:first']);
    assert.deepEqual([...c.contents], ['first']);
  });

  it('does not wait on readiness when there is nothing to replace', async () => {
    // A first load must reach the globe immediately, not after a ready gate.
    const c = fakeCollection();
    const gate = deferredReady();

    await swapCesiumModel(c, null, 'first', gate.whenReady);

    assert.deepEqual([...c.contents], ['first']);
  });

  it('touches nothing when asked to replace a model with itself', async () => {
    // Re-adding a primitive already in the collection is not harmless on the
    // real one — it would duplicate the draw or throw — and there would be
    // nothing left to release afterwards.
    const c = fakeCollection();
    c.add('same');
    c.ops.length = 0;

    await swapCesiumModel(c, 'same', 'same', readyNow);

    assert.deepEqual(c.ops, [], 'no add, no remove');
    assert.deepEqual([...c.contents], ['same']);
  });
});
