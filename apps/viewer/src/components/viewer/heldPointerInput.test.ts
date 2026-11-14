/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heldPointerQueue, observeHeldPointerInput } from './heldPointerQueue.js';

const state = (held: boolean) => ({
  geometryStreamingActive: false, loading: false, progress: null,
  models: new Map([['m', { geometryRestorePending: held, loadState: 'complete' }]]),
});
const click = (replayed: string[], button = 0) => ({
  x: 10, y: 20, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, button, handler: 'test', replay: () => { replayed.push('replayed'); },
});

describe('held click: what counts as newer input (DOM events)', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; heldPointerQueue.clear(); });

  it('the queued gesture\'s own release (pointerup, touchend, keyup) does not cancel it: a context menu queued on press still replays', () => {
    stop = observeHeldPointerInput(document.createElement('canvas'));
    const replayed: string[] = [];
    heldPointerQueue.queue(click(replayed, 2), state(true));
    for (const type of ['pointerup', 'touchend']) document.dispatchEvent(new Event(type, { bubbles: true }));
    window.dispatchEvent(new Event('keyup'));
    assert.equal(heldPointerQueue.release(state(false)), true);
    assert.deepEqual(replayed, ['replayed']);
  });

  for (const [target, type] of [['document', 'pointerdown'], ['document', 'touchstart'], ['document', 'wheel'], ['window', 'keydown']] as const) {
    it(`a newer ${type} cancels the replay`, () => {
      stop = observeHeldPointerInput(document.createElement('canvas'));
      const replayed: string[] = [];
      heldPointerQueue.queue(click(replayed), state(true));
      (target === 'window' ? window : document).dispatchEvent(new Event(type, { bubbles: true }));
      assert.equal(heldPointerQueue.release(state(false)), false);
      assert.deepEqual(replayed, []);
    });
  }

  it('a hover move (no buttons) does not cancel; a drag move does', () => {
    stop = observeHeldPointerInput(document.createElement('canvas'));
    const replayed: string[] = [];
    const move = (buttons: number) => { const e = new Event('pointermove', { bubbles: true }); Object.defineProperty(e, 'buttons', { value: buttons }); return e; };
    heldPointerQueue.queue(click(replayed), state(true));
    document.dispatchEvent(move(0));
    assert.equal(heldPointerQueue.release(state(false)), true);
    heldPointerQueue.queue(click(replayed), state(true));
    document.dispatchEvent(move(1));
    assert.equal(heldPointerQueue.release(state(false)), false);
    assert.deepEqual(replayed, ['replayed']);
  });
});
