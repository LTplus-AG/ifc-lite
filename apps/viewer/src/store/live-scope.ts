/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which state a component's `useViewerStore(selector)` reads (#10535): the
 * settled state everywhere (`settled-store.ts`), live state inside a
 * `LiveViewerScope`. The scope is the explicit allowlist of what must follow an
 * edit inside its own task: the viewport, which takes the edit's geometry,
 * and what draws over it, the plan pane while it is shown, and the session
 * effects in `ShellStoreEffects` (unload guard, overlay compositor). `useViewerStore.getState()` and the
 * rest of the store API are always live.
 */

import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ViewerState } from './index.js';
import type { ViewerStoreApi } from './viewerStoreHandle.js';
import { settledStoreOf } from './settled-store.js';

const LiveScope = createContext(false);

/**
 * Components under this read live state through `useViewerStore`. `live={false}`
 * turns it off without remounting what is under it (a hidden plan pane).
 */
export function LiveViewerScope({ children, live = true }: { children: ReactNode; live?: boolean }) {
  return createElement(LiveScope.Provider, { value: live }, children);
}

const wholeState = (state: ViewerState) => state;

/** The app's `useViewerStore`: the live store's API, with a hook that reads settled state outside a live scope. */
export function scopedViewerStore(live: ViewerStoreApi): ViewerStoreApi {
  const settled = settledStoreOf(live);
  function useScopedViewerStore(): ViewerState;
  function useScopedViewerStore<U>(selector: (state: ViewerState) => U): U;
  function useScopedViewerStore<U>(selector?: (state: ViewerState) => U): U | ViewerState {
    const pick: (state: ViewerState) => U | ViewerState = selector ?? wholeState;
    return useStore(useContext(LiveScope) ? live : settled, pick);
  }
  return Object.assign(useScopedViewerStore, live);
}
