/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store churn counters (#6957), as ONE middleware around the whole viewer
 * store rather than an edit per slice:
 *
 *   store.setState        every write, from a slice's `set` or `useViewerStore.setState`
 *   store.notifications   subscriber callbacks run by those writes; each one
 *                         re-evaluates that subscriber's selector, so this is the
 *                         selector re-evaluation count `useViewerStore(selector)` causes
 *
 * It must be the OUTERMOST middleware: inner ones (visibility invalidation)
 * replace `api.setState` with a wrapper that calls the `set` handed to them,
 * which is this counted one, so every write is counted exactly once. With
 * counters off each write pays one boolean test; subscriptions are wrapped
 * only while counters are on.
 */

import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import { perfCount, perfCounters } from '@ifc-lite/load-trace';

export function withStoreChurnCounters<
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(creator: StateCreator<T, Mps, Mcs>): StateCreator<T, Mps, Mcs> {
  return ((set: (...a: unknown[]) => void, get: unknown, api: { setState: unknown; subscribe: (l: (...a: unknown[]) => void) => () => void }) => {
    const countedSet = (...args: unknown[]) => {
      perfCount('store.setState');
      set(...args);
    };
    api.setState = countedSet;
    const subscribe = api.subscribe;
    api.subscribe = (listener) => subscribe(perfCounters.enabled
      ? (...args: unknown[]) => { perfCount('store.notifications'); listener(...args); }
      : listener);
    return (creator as unknown as (...a: unknown[]) => T)(countedSet, get, api);
  }) as unknown as StateCreator<T, Mps, Mcs>;
}
