/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer store singleton, readable without importing `store/index`.
 *
 * Modules that `store/index` reaches while it evaluates (its re-exports, the
 * actions it composes) must not import `store/index` back: that import cycle
 * leaves them holding an uninitialised binding when evaluation order shifts
 * (#10218 broke merge-queue batches that way). Such modules read the live
 * store through this handle at call time instead. `store/index` owns
 * creation and stores the singleton here.
 */

import type { StoreApi, UseBoundStore } from 'zustand';
import type { ViewerState } from './index.js';

const STORE_SINGLETON_KEY = '__ifc_lite_viewer_store__';

export type ViewerStoreApi = UseBoundStore<StoreApi<ViewerState>>;

const globalStoreRegistry = globalThis as typeof globalThis & {
  [STORE_SINGLETON_KEY]?: ViewerStoreApi;
};

/** The registered singleton, or undefined before `store/index` has evaluated. */
export function peekViewerStore(): ViewerStoreApi | undefined {
  return globalStoreRegistry[STORE_SINGLETON_KEY];
}

/** Called once by `store/index` when it creates the store. */
export function registerViewerStore(store: ViewerStoreApi): void {
  globalStoreRegistry[STORE_SINGLETON_KEY] = store;
}

/** The live store state. Throws when called before the `@/store` entry is imported. */
export function getViewerState(): ViewerState {
  const store = globalStoreRegistry[STORE_SINGLETON_KEY];
  if (!store) throw new Error("viewer store read before '@/store' was imported");
  return store.getState();
}
