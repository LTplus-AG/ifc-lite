/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Loaded at runtime so a build without the module fails these assertions instead of failing to load (revert oracle). */
async function load(): Promise<{ createLoadWindow: typeof import('./loadWindow.js').createLoadWindow; MAX_TAIL_WAIT_MS: number }> {
  const mod = (await import('./loadWindow.js').catch(() => null)) as Record<string, unknown> | null;
  assert.equal(typeof mod?.createLoadWindow, 'function', 'loadWindow.ts must export createLoadWindow');
  return mod as never;
}

/** Manual store flags, tail flag, clock, frame and timer queues. */
async function harness() {
  const { createLoadWindow, MAX_TAIL_WAIT_MS } = await load();
  let storeBusy = false, tailBusy = false, t = 0;
  const storeListeners = new Set<() => void>();
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const win = createLoadWindow({
    storeBusy: () => storeBusy,
    subscribeStore: (l) => { storeListeners.add(l); return () => storeListeners.delete(l); },
    tailBusy: () => tailBusy,
    now: () => t,
    requestFrame: (fn) => { frames.push(fn); },
    setTimer: (fn) => { timers.push(fn); },
  });
  const changes: boolean[] = [];
  const unsubscribe = win.subscribe(() => changes.push(win.isOpen()));
  const store = (busy: boolean) => { storeBusy = busy; for (const l of [...storeListeners]) l(); };
  const frame = () => { const fns = frames.splice(0); for (const fn of fns) fn(); };
  const timer = () => { const fns = timers.splice(0); for (const fn of fns) fn(); };
  return {
    win, changes, store, frame, timer, unsubscribe, MAX_TAIL_WAIT_MS,
    setTail: (busy: boolean) => { tailBusy = busy; },
    advance: (ms: number) => { t += ms; },
    pendingChecks: () => frames.length + timers.length,
    storeSubscribed: () => storeListeners.size > 0,
  };
}

describe('load window', () => {
  it('is closed outside a load, even while the scene happens to have queued work', async () => {
    const h = await harness();
    h.setTail(true);
    h.store(false);
    assert.equal(h.win.isOpen(), false);
    assert.equal(h.pendingChecks(), 0, 'no load, no polling');
  });

  it('opens when the store starts loading and closes only once the geometry tail has finished', async () => {
    const h = await harness();
    h.store(true);
    assert.equal(h.win.isOpen(), true);
    h.setTail(true);
    h.store(false);
    assert.equal(h.win.isOpen(), true, 'loading and streaming are clear, but the drain/finalize still runs');
    h.frame();
    assert.equal(h.win.isOpen(), true, 'still busy on the next frame');
    h.setTail(false);
    h.frame();
    assert.equal(h.win.isOpen(), false, 'tail finished: settled');
    assert.deepEqual(h.changes, [true, false], 'one open, one close');
    h.timer();
    assert.equal(h.win.isOpen(), false, 'spent backstop timers do nothing after the close');
    assert.deepEqual(h.changes, [true, false]);
  });

  it('re-checks from a timer when frames stop (hidden tab)', async () => {
    const h = await harness();
    h.store(true); h.setTail(true); h.store(false);
    h.setTail(false);
    h.timer();
    assert.equal(h.win.isOpen(), false);
  });

  it('closes after the tail limit even if the finalize never ends', async () => {
    const h = await harness();
    h.store(true); h.setTail(true); h.store(false);
    h.advance(h.MAX_TAIL_WAIT_MS - 1); h.frame();
    assert.equal(h.win.isOpen(), true);
    h.advance(2); h.frame();
    assert.equal(h.win.isOpen(), false, 'a stuck finalize must not hide the values for ever');
  });

  it('reopens for the next load', async () => {
    const h = await harness();
    h.store(true); h.store(false);
    assert.equal(h.win.isOpen(), false);
    h.store(true);
    assert.equal(h.win.isOpen(), true);
    assert.deepEqual(h.changes, [true, false, true]);
  });

  it('reports an open window on the first read, before any consumer subscribed (a component mounted mid-load)', async () => {
    const { createLoadWindow } = await load();
    const win = createLoadWindow({
      storeBusy: () => true, subscribeStore: () => () => {}, tailBusy: () => false,
      now: () => 0, requestFrame: () => {}, setTimer: () => {},
    });
    assert.equal(win.isOpen(), true);
  });

  it('stops listening to the store when its last consumer unsubscribes', async () => {
    const h = await harness();
    assert.equal(h.storeSubscribed(), true);
    h.unsubscribe();
    assert.equal(h.storeSubscribed(), false);
  });
});
