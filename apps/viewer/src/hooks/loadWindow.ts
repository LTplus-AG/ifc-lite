/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The load window: from the moment a load starts until its scene has settled
 * (store no longer loading, geometry no longer streaming, and the post-stream
 * upload drain and renderer finalize finished).
 *
 * Whole-model derived UI values (the status bar's object count, the model
 * metadata panel's statistics, the IfcGrid / annotation overlay parse keys)
 * walk every entity and mesh. Computed while the window is open they ran on
 * the main thread inside the drain and finalize, which end the load: traced on
 * Holter about 260-280 ms of main-thread work between stream complete and
 * interactive, recomputed on every store publication. Consumers read
 * `useLoadWindowOpen()` and show a placeholder until it closes, then compute once.
 *
 * Signal: `loading` and `geometryStreamingActive` come from the store. The
 * renderer publishes no event when its finalize ends, so once both flags are
 * clear the window re-checks `isGeometryTailBusy()` once per animation frame
 * (constant-time scene flags), with a timer backstop for hidden tabs where
 * frames stop. After `MAX_TAIL_WAIT_MS` of tail it closes anyway: a finalize
 * that never ends (device loss keeps its fragments) must not hide these values.
 */

import { useSyncExternalStore } from 'react';
import { useViewerStore, type ViewerState } from '@/store';
import { isGeometryTailBusy } from './geometryTail.js';

export const MAX_TAIL_WAIT_MS = 3_000;
const BACKSTOP_MS = 100;

export interface LoadWindowDeps {
  /** True while the store is loading or geometry is streaming. */
  storeBusy: () => boolean;
  /** Subscribe to store changes; returns the unsubscribe function. */
  subscribeStore: (listener: () => void) => () => void;
  tailBusy: () => boolean;
  now: () => number;
  requestFrame: (fn: () => void) => void;
  setTimer: (fn: () => void, ms: number) => void;
}

export interface LoadWindow {
  isOpen: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export function createLoadWindow(deps: LoadWindowDeps): LoadWindow {
  const listeners = new Set<() => void>();
  let open = false;
  let tailSince = -1;
  let checkScheduled = false;

  const set = (next: boolean): void => {
    if (next === open) return;
    open = next;
    for (const listener of [...listeners]) listener();
  };
  const scheduleCheck = (): void => {
    if (checkScheduled) return;
    checkScheduled = true;
    let ran = false;
    const run = (): void => { if (ran) return; ran = true; checkScheduled = false; evaluate(); };
    deps.requestFrame(run);
    deps.setTimer(run, BACKSTOP_MS);
  };
  const evaluate = (): void => {
    if (deps.storeBusy()) { tailSince = -1; set(true); return; }
    if (!open) return; // nothing was loading: an idle scene is not a load window
    if (tailSince < 0) tailSince = deps.now();
    if (deps.tailBusy() && deps.now() - tailSince < MAX_TAIL_WAIT_MS) { scheduleCheck(); return; }
    tailSince = -1;
    set(false);
  };

  // Observe the store from creation, not only while a consumer is subscribed:
  // a consumer mounted after the store flags cleared, while the drain or
  // finalize still runs, must still see the window open. The viewer creates the
  // window when its first consumer module loads (the status bar, at boot), so
  // every load is seen from its start.
  deps.subscribeStore(evaluate);
  evaluate();

  return {
    isOpen: () => open,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const storeBusy = (s: ViewerState): boolean => s.loading || s.geometryStreamingActive;

let viewerLoadWindow: LoadWindow | null = null;
function getViewerLoadWindow(): LoadWindow {
  viewerLoadWindow ??= createLoadWindow({
    storeBusy: () => storeBusy(useViewerStore.getState()),
    subscribeStore: (listener) => useViewerStore.subscribe((s, prev) => { if (storeBusy(s) !== storeBusy(prev)) listener(); }),
    tailBusy: isGeometryTailBusy,
    now: () => performance.now(),
    requestFrame: (fn) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn()); },
    setTimer: (fn, ms) => { setTimeout(fn, ms); },
  });
  return viewerLoadWindow;
}

// Created with this module: the status bar imports it at boot, before any load.
getViewerLoadWindow();

/** True from load start until the scene settles; false outside any load. */
export function useLoadWindowOpen(): boolean {
  const loadWindow = getViewerLoadWindow();
  return useSyncExternalStore(loadWindow.subscribe, loadWindow.isOpen, () => false);
}

