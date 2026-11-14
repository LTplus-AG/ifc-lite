/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LatestHeldPointerQueue } from './heldPointerQueue.js';

const state = (held: boolean, models: ReadonlyMap<string, { geometryRestorePending?: boolean; loadState?: string }> = new Map([['m', { geometryRestorePending: held, loadState: 'loaded' }]])) => ({
  geometryStreamingActive: false, loading: false, progress: null, models,
});

const click = (x: number, replay: () => void) => ({
  x, y: 19, shiftKey: true, ctrlKey: false, metaKey: true, altKey: false, button: 0, handler: 'selection:select', replay,
});

describe('LatestHeldPointerQueue', () => {
  it('replays only the latest click with its original pointer data when released', () => {
    const queue = new LatestHeldPointerQueue();
    const replayed: unknown[] = [];
    queue.queue(click(12, record => replayed.push(record)), state(true));
    queue.queue(click(42, record => replayed.push(record)), state(true));
    assert.equal(queue.release(state(false)), true);
    assert.deepEqual(replayed, [{ x: 42, y: 19, shiftKey: true, ctrlKey: false, metaKey: true, altKey: false, button: 0, handler: 'selection:select' }]);
  });

  it('skips replay after newer pointer, key, or wheel input', () => {
    for (const input of ['pointer', 'key', 'wheel']) {
      const queue = new LatestHeldPointerQueue();
      let replayed = false;
      queue.queue(click(12, () => { replayed = true; }), state(true));
      queue.invalidate();
      queue.release(state(false));
      assert.equal(replayed, false, input);
    }
  });

  it('skips a removed or errored model and queues nothing when not held', () => {
    for (const models of [new Map(), new Map([['m', { loadState: 'error' }]])]) {
      const queue = new LatestHeldPointerQueue();
      let replayed = false;
      queue.queue(click(12, () => { replayed = true; }), state(true));
      queue.release(state(false, models));
      assert.equal(replayed, false);
    }
    const queue = new LatestHeldPointerQueue();
    assert.equal(queue.queue(click(12, () => {}), state(false)), false);
  });
});
