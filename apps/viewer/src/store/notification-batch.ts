/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One subscriber pass for a burst of synchronous store writes.
 *
 * A primary load's reset (`resetViewerState`, `clearAllModels`,
 * `clearLayerStack`, the loading flags, the placeholder model) is ~32 `set`
 * calls in one task, 14 of which change nothing. Every call runs every
 * subscriber, and each `useViewerStore(selector)` re-evaluates its selector:
 * about 40 ms of a Holter reopen's pick task (traced, today's main) went to
 * that fan-out.
 *
 * While a hold is open, writes still apply at once (`get()` inside the burst
 * sees them), but each subscriber's callback is deferred. On the last release
 * each subscriber that was due runs ONCE with `(final state, the state before
 * its first deferred write)`, in subscription order. A subscriber that
 * unsubscribed meanwhile is not called. A write made by a subscriber during
 * that flush notifies normally.
 *
 * Contract for holders: synchronous code only, and release on every path
 * (`release` is idempotent). A hold left open across an `await` would delay
 * every subscriber, React included, until it closes.
 *
 * Outermost middleware: it wraps only `subscribe`, so `withStoreChurnCounters`
 * (#6957) counts the callbacks that actually run.
 */

import type { StateCreator, StoreMutatorIdentifier } from 'zustand';

type Listener = (state: unknown, prev: unknown) => void;
interface StoreBatch { getState: () => unknown; due: Map<object, { listener: Listener; prev: unknown }> }

let depth = 0;
/** Per store: due subscriptions -> the state before their first deferred write (insertion order = subscription order). */
const stores = new Set<StoreBatch>();

function flush(): void {
  for (const store of stores) {
    if (store.due.size === 0) continue;
    const state = store.getState();
    const pending = [...store.due.values()];
    store.due.clear();
    for (const { listener, prev } of pending) {
      if (state !== prev) listener(state, prev);
    }
  }
}

/** Open a hold; the returned release is idempotent and flushes when the last hold closes. */
export function holdViewerStoreNotifications(): () => void {
  depth += 1;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    depth -= 1;
    if (depth === 0) flush();
  };
}

export function withNotificationBatching<
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(creator: StateCreator<T, Mps, Mcs>): StateCreator<T, Mps, Mcs> {
  return ((set: unknown, get: () => unknown, api: { subscribe: (l: Listener) => () => void }) => {
    const store: StoreBatch = { getState: get, due: new Map() };
    stores.add(store);
    const subscribe = api.subscribe;
    api.subscribe = (listener) => {
      const key = {}; // per subscription: the same function subscribed twice is notified twice, as without a hold
      const unsubscribe = subscribe((state, prev) => {
        if (depth === 0) { listener(state, prev); return; }
        if (!store.due.has(key)) store.due.set(key, { listener, prev });
      });
      return () => { store.due.delete(key); unsubscribe(); };
    };
    return (creator as unknown as (...a: unknown[]) => T)(set, get, api);
  }) as unknown as StateCreator<T, Mps, Mcs>;
}
