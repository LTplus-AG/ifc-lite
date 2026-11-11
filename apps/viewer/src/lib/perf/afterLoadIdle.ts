/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run work that no load waits for after the load in progress is interactive.
 * With no load in progress it runs at once, as before. During a load (store
 * `loading` or a geometry stream) it waits for the load to settle and then for
 * an idle period (at most `IDLE_TIMEOUT_MS`; at once in a hidden tab), so it
 * leaves the window between "the model is on screen" and "interactive".
 * Returns a cancel function.
 */

import { useViewerStore } from '../../store/index.js';

const IDLE_TIMEOUT_MS = 1000;

function loadInProgress(): boolean {
  const { loading, geometryStreamingActive } = useViewerStore.getState();
  return loading || geometryStreamingActive;
}

export function runAfterLoadIdle(work: () => void): () => void {
  if (!loadInProgress()) {
    work();
    return () => {};
  }
  let cancelled = false;
  let idleHandle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => { if (!cancelled) work(); };
  const whenIdle = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return run();
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') idleHandle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    else timer = setTimeout(run, 0);
  };
  const unsubscribe = useViewerStore.subscribe(() => {
    if (loadInProgress()) return;
    unsubscribe();
    whenIdle();
  });
  return () => {
    cancelled = true;
    unsubscribe();
    if (idleHandle !== null && typeof window !== 'undefined') window.cancelIdleCallback?.(idleHandle);
    if (timer !== null) clearTimeout(timer);
  };
}
