/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Loaded at runtime so a build without the module fails these assertions instead of failing to load (revert oracle). */
async function load(): Promise<{ createLoadWindow: typeof import('./loadWindow.js').createLoadWindow; MAX_TAIL_WAIT_MS: number; MAX_STORE_BUSY_MS: number }> {
  const mod = (await import('./loadWindow.js').catch(() => null)) as Record<string, unknown> | null;
  assert.equal(typeof mod?.createLoadWindow, 'function', 'loadWindow.ts must export createLoadWindow');
  assert.equal(typeof mod?.MAX_STORE_BUSY_MS, 'number', 'loadWindow.ts must export MAX_STORE_BUSY_MS');
  return mod as never;
}

/** Manual store flags, tail flag, clock, frame and timer queues. */
async function harness() {
  const { createLoadWindow, MAX_TAIL_WAIT_MS, MAX_STORE_BUSY_MS } = await load();
  let storeBusy = false, tailBusy = false, t = 0;
  const models = new Map<string, string | undefined>();
  const storeListeners = new Set<() => void>();
  let frames: Array<() => void> = [];
  let timers: Array<() => void> = [];
  const win = createLoadWindow({
    storeBusy: () => storeBusy,
    modelStates: () => models.entries(),
    subscribeStore: (l) => { storeListeners.add(l); return () => storeListeners.delete(l); },
    tailBusy: () => tailBusy,
    now: () => t,
    requestFrame: (fn) => { frames.push(fn); },
    setTimer: (fn) => { timers.push(fn); },
  });
  const changes: boolean[] = [];
  win.subscribe(() => changes.push(win.isOpen()));
  const store = (busy: boolean) => { storeBusy = busy; for (const l of [...storeListeners]) l(); };
  const frame = () => { const fns = frames; frames = []; for (const fn of fns) fn(); };
  const timer = () => { const fns = timers; timers = []; for (const fn of fns) fn(); };
  /** Set (or with `undefined` as `remove`, delete) a model's load state and notify like a store publish. */
  const model = (id: string, state: string | undefined, remove = false) => {
    if (remove) models.delete(id); else models.set(id, state);
    for (const l of [...storeListeners]) l();
  };
  return {
    win, changes, store, frame, timer, model, MAX_TAIL_WAIT_MS, MAX_STORE_BUSY_MS,
    /** One painted frame, then the tasks queued behind it. */
    settle: () => { frame(); timer(); },
    setTail: (busy: boolean) => { tailBusy = busy; },
    advance: (ms: number) => { t += ms; },
    pendingChecks: () => frames.length + timers.length,
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
    h.settle(); h.settle();
    assert.equal(h.win.isOpen(), false, 'tail finished and its frame painted: settled');
    assert.deepEqual(h.changes, [true, false], 'one open, one close');
    h.timer();
    assert.equal(h.win.isOpen(), false, 'spent backstop timers do nothing after the close');
    assert.deepEqual(h.changes, [true, false]);
  });

  it('closes only after the settled frame has painted, so consumers do not delay it', async () => {
    const h = await harness();
    h.store(true);
    h.store(false); // tail idle: the load has settled
    assert.equal(h.win.isOpen(), true, 'the settle task itself must not re-render the whole-model consumers');
    h.frame();
    assert.equal(h.win.isOpen(), true, 'the settled frame paints with the window still open');
    h.timer();
    assert.equal(h.win.isOpen(), false, 'closed in a task after that frame');
  });

  it('stays open when a new load starts before the close lands', async () => {
    const h = await harness();
    h.store(true); h.store(false);
    h.store(true);
    h.settle();
    assert.equal(h.win.isOpen(), true);
    assert.deepEqual(h.changes, [true]);
  });

  it('re-checks from timers when frames stop (hidden tab)', async () => {
    const h = await harness();
    h.store(true); h.setTail(true); h.store(false);
    h.setTail(false);
    h.timer(); // the tail re-check backstop
    h.timer(); // the close backstop
    assert.equal(h.win.isOpen(), false);
  });

  it('closes after the tail limit even if the finalize never ends', async () => {
    const h = await harness();
    h.store(true); h.setTail(true); h.store(false);
    h.advance(h.MAX_TAIL_WAIT_MS - 1); h.frame();
    assert.equal(h.win.isOpen(), true);
    h.advance(2); h.settle(); h.settle();
    assert.equal(h.win.isOpen(), false, 'a stuck finalize must not hide the values for ever');
  });

  it('reopens for the next load', async () => {
    const h = await harness();
    h.store(true); h.store(false); h.settle();
    assert.equal(h.win.isOpen(), false);
    h.store(true);
    assert.equal(h.win.isOpen(), true);
    assert.deepEqual(h.changes, [true, false, true]);
  });

  it('reports an open window on the first read, before any consumer subscribed (a component mounted mid-load)', async () => {
    const { createLoadWindow } = await load();
    const win = createLoadWindow({
      storeBusy: () => true, modelStates: () => [], subscribeStore: () => () => {}, tailBusy: () => false,
      now: () => 0, requestFrame: () => {}, setTimer: () => {},
    });
    assert.equal(win.isOpen(), true);
  });

  it('a consumer that first subscribes during the tail, after the store flags cleared, still sees the window open', async () => {
    const h = await harness();
    // The load runs with no consumer looking yet.
    h.store(true);
    h.setTail(true); h.store(false);
    const seen: boolean[] = [];
    h.win.subscribe(() => seen.push(h.win.isOpen()));
    assert.equal(h.win.isOpen(), true, 'late consumer: the window is still open');
    h.setTail(false); h.settle(); h.settle();
    assert.equal(h.win.isOpen(), false);
    assert.deepEqual(seen, [false], 'the late consumer is told when it closes');
  });

  it('re-checks the tail when it starts again between the settle check and the close (close/reopen race)', async () => {
    const h = await harness();
    h.store(true); h.store(false); // tail idle: the close is scheduled behind the next frame
    h.setTail(true); // a late fragment arrives before that frame
    h.settle();
    assert.equal(h.win.isOpen(), true, 'the close must not land while the tail is busy again');
    h.setTail(false);
    h.settle(); h.settle();
    assert.equal(h.win.isOpen(), false, 'closes once the tail is idle again');
    assert.deepEqual(h.changes, [true, false]);
  });

  it('the tail limit still applies across a restarted tail', async () => {
    const h = await harness();
    h.store(true); h.store(false);
    h.setTail(true);
    h.settle();
    h.advance(h.MAX_TAIL_WAIT_MS + 1);
    h.settle(); h.settle();
    assert.equal(h.win.isOpen(), false, 'a tail that never ends cannot keep re-arming the close');
  });

  it('closes after the store-busy limit even if loading never clears, then reopens only for a new load', async () => {
    const h = await harness();
    h.store(true);
    h.advance(h.MAX_STORE_BUSY_MS - 1); h.timer();
    assert.equal(h.win.isOpen(), true);
    h.advance(2); h.timer();
    h.settle();
    assert.equal(h.win.isOpen(), false, 'a stuck loading flag must not hide the values for ever: consumers compute');
    h.model('m', 'complete');
    assert.equal(h.win.isOpen(), false, 'a publish while the flag is still stuck does not reopen it');
    h.store(false);
    h.store(true);
    assert.equal(h.win.isOpen(), true, 'the next load opens it again');
  });

  it('holds only the loading model: a model settled when the window opened keeps its values', async () => {
    const h = await harness();
    h.model('A', 'complete');
    h.store(true);
    h.model('B', 'pending');
    assert.equal(h.win.isOpen(), true);
    assert.equal(h.win.isHeld('A'), false, 'A was complete when B started loading');
    assert.equal(h.win.isHeld('B'), true);
    h.model('B', 'complete');
    assert.equal(h.win.isHeld('B'), true, 'B stays held until the window closes, even once its own state reads complete');
    h.store(false); h.settle();
    assert.equal(h.win.isHeld('B'), false, 'settled: B is computed');
  });

  it('holds a settled model again when it is seen reloading, and every model in single-store mode', async () => {
    const h = await harness();
    h.model('A', 'complete');
    h.store(true);
    const before = h.win.hold();
    assert.equal(before.isHeld('A'), false);
    h.model('A', 'pending'); // the same id reloaded
    assert.equal(h.win.isHeld('A'), true);
    assert.notEqual(h.win.hold(), before, 'a new snapshot when the held set changes (React re-renders)');
    assert.equal(before.isHeld('A'), false, 'old snapshots are immutable');
    assert.equal(h.win.isHeld('legacy'), true, 'no model entry: the single store is the one loading');
  });

  it('releases a model added already complete during the window (cache hit) on its own settle, while the store is still loading', async () => {
    const h = await harness();
    h.store(true);
    h.model('C', 'complete');
    assert.equal(h.win.isHeld('C'), true, 'held until its settled frame has painted');
    h.settle();
    assert.equal(h.win.isHeld('C'), false, 'its own settle releases it, although the store still reads loading');
    assert.equal(h.win.isOpen(), true);
  });

  it('multi-file open: model A is released at its own settle although the next file started loading before A\'s frame', async () => {
    const h = await harness();
    h.store(true); // loadFilesSequentially: file A
    h.model('A', 'pending');
    h.setTail(true);
    h.model('A', 'streaming-geometry');
    h.model('A', 'complete'); // finalize ran inside A's tail
    h.frame();
    assert.equal(h.win.isHeld('A'), true, 'A\'s tail still runs: held');
    h.setTail(false);
    h.model('B', 'pending'); // file B starts at once: the store never stops loading
    h.settle(); h.settle();
    assert.equal(h.win.isHeld('A'), false, 'A settled and its frame painted: released');
    assert.equal(h.win.isHeld('B'), true, 'B is loading: held');
    assert.equal(h.win.isOpen(), true, 'the window stays open for B');
    h.model('B', 'complete'); h.store(false); h.settle(); h.settle();
    assert.equal(h.win.isHeld('B'), false);
    assert.equal(h.win.isOpen(), false);
  });

  it('a model\'s release re-checks the tail behind its frame, and its tail limit still applies', async () => {
    const h = await harness();
    h.store(true);
    h.model('A', 'complete'); // tail idle: the release is scheduled behind a frame
    h.setTail(true); // B's stream starts before that frame
    h.settle();
    assert.equal(h.win.isHeld('A'), true, 'the tail is busy again: still held');
    h.advance(h.MAX_TAIL_WAIT_MS + 1);
    h.settle(); h.settle();
    assert.equal(h.win.isHeld('A'), false, 'a tail that does not end (the next file streaming) cannot hold A past its limit');
  });

  it('a released model seen loading again is held again', async () => {
    const h = await harness();
    h.store(true);
    h.model('A', 'complete'); h.settle();
    assert.equal(h.win.isHeld('A'), false);
    h.model('A', 'pending');
    assert.equal(h.win.isHeld('A'), true);
  });
});
