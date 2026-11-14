/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { holdViewerStoreNotifications, withNotificationBatching } from './notification-batch.js';
import { useViewerStore } from './index.js';

type S = { a: number; b: number; bump: () => void };
const makeStore = () => create<S>()(withNotificationBatching((set) => ({ a: 0, b: 0, bump: () => set((s) => ({ a: s.a + 1 })) })));

describe('store notification batching', () => {
  it('without a hold every write notifies, as before', () => {
    const store = makeStore(); const calls: number[] = [];
    store.subscribe((s) => calls.push(s.a));
    store.getState().bump(); store.getState().bump();
    assert.deepEqual(calls, [1, 2]);
  });

  it('under a hold writes apply at once but each subscriber runs once, with the pre-burst state as prev', () => {
    const store = makeStore(); const calls: Array<[number, number]> = [];
    store.subscribe((s, p) => calls.push([s.a, p.a]));
    const release = holdViewerStoreNotifications();
    store.getState().bump(); store.getState().bump(); store.setState({ b: 5 });
    assert.equal(store.getState().a, 2, 'get() sees writes inside the hold');
    assert.deepEqual(calls, []);
    release();
    assert.deepEqual(calls, [[2, 0]]);
    release(); // idempotent
    assert.deepEqual(calls, [[2, 0]]);
  });

  it('keeps subscription order, notifies a function subscribed twice twice, and skips an unsubscribed one', () => {
    const store = makeStore(); const order: string[] = [];
    const twice = () => order.push('twice');
    store.subscribe(() => order.push('first'));
    store.subscribe(twice); store.subscribe(twice);
    const gone = store.subscribe(() => order.push('gone'));
    const release = holdViewerStoreNotifications();
    store.getState().bump();
    gone();
    release();
    assert.deepEqual(order, ['first', 'twice', 'twice']);
  });

  it('flushes only when the outermost of nested holds closes', () => {
    const store = makeStore(); let n = 0;
    store.subscribe(() => { n += 1; });
    const outer = holdViewerStoreNotifications();
    const inner = holdViewerStoreNotifications();
    store.getState().bump(); inner();
    assert.equal(n, 0);
    store.getState().bump(); outer();
    assert.equal(n, 1);
  });

  it('a write made by a subscriber during the flush notifies normally', () => {
    const store = makeStore(); const seen: number[] = [];
    store.subscribe((s) => { seen.push(s.a); if (s.a === 1) store.getState().bump(); });
    const release = holdViewerStoreNotifications();
    store.getState().bump();
    release();
    assert.deepEqual(seen, [1, 2]);
  });

  it('a primary reset of the viewer store runs each subscriber once under a hold (many times without)', () => {
    const reset = () => {
      const s = useViewerStore.getState();
      s.resetViewerState(); s.clearAllModels(); s.clearLayerStack();
      s.setLoading(true); s.setError(null); s.setProgress({ phase: 'Loading file', percent: 0 });
    };
    let free = 0;
    const off = useViewerStore.subscribe(() => { free += 1; });
    reset();
    off();
    let held = 0;
    const off2 = useViewerStore.subscribe(() => { held += 1; });
    const release = holdViewerStoreNotifications();
    reset();
    release();
    off2();
    assert.ok(free >= 6, `without a hold the reset notified ${free} times`);
    assert.equal(held, 1);
  });
});
