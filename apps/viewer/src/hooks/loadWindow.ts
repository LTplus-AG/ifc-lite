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
 * `useLoadWindowHold()` and show a placeholder for a held model until the
 * window closes, then compute once.
 *
 * Per model: the window holds only the models that are loading. A model whose
 * load was complete when the window opened keeps its values (overlays, counts,
 * statistics, pills) while another model loads, unless it is seen loading again
 * (a reload) while the window is open. A model that loads inside the window is
 * released on its own settle: its state is terminal (finalize ran, so its
 * stream is over), the geometry tail is idle (or `MAX_TAIL_WAIT_MS` has passed
 * since it turned terminal), and a frame has painted. That does not wait for
 * the store's loading flags, so in a multi-file open the next file's load does
 * not keep an earlier, settled model held. In single-store mode the store is
 * the one being loaded, so `legacy` is held until the window closes.
 *
 * Signal: `loading` and `geometryStreamingActive` come from the store. The
 * renderer publishes no event when its finalize ends, so once both flags are
 * clear the window re-checks `isGeometryTailBusy()` once per animation frame
 * (constant-time scene flags), with a timer backstop for hidden tabs where
 * frames stop. After `MAX_TAIL_WAIT_MS` of tail it closes anyway: a finalize
 * that never ends (device loss keeps its fragments) must not hide these values,
 * and after `MAX_STORE_BUSY_MS` of a store that stays loading (a stuck flag) it
 * closes too and the consumers compute their values.
 */

import { useSyncExternalStore } from 'react';
import { useViewerStore, type ViewerState } from '@/store';
import { isGeometryTailBusy } from './geometryTail.js';

export const MAX_TAIL_WAIT_MS = 3_000;
export const MAX_STORE_BUSY_MS = 30_000;
const BACKSTOP_MS = 100;
const CLOSE_BACKSTOP_MS = 1_000;

/** A model's load lifecycle as the store reports it (`FederatedModel.loadState`). */
export type ModelLoadState = string | undefined;
const LOADING_STATES: ReadonlySet<ModelLoadState> = new Set(['pending', 'streaming-geometry', 'hydrating-metadata']);

export interface LoadWindowDeps {
  /** True while the store is loading or geometry is streaming. */
  storeBusy: () => boolean;
  /** Every model in the store with its load state. */
  modelStates: () => Iterable<readonly [string, ModelLoadState]>;
  /** Subscribe to store changes (busy flags or the model map); returns the unsubscribe function. */
  subscribeStore: (listener: () => void) => () => void;
  tailBusy: () => boolean;
  now: () => number;
  requestFrame: (fn: () => void) => void;
  setTimer: (fn: () => void, ms: number) => void;
}

/** What the window holds right now; a new object whenever that changes. */
export interface LoadWindowHold {
  /** True from a load's start until its scene settles. */
  readonly open: boolean;
  /** True while this model's whole-model values must wait: the window is open and the model is not one that was settled when it opened. */
  isHeld(modelId: string): boolean;
}

export interface LoadWindow {
  isOpen: () => boolean;
  isHeld: (modelId: string) => boolean;
  hold: () => LoadWindowHold;
  subscribe: (listener: () => void) => () => void;
}

const CLOSED: LoadWindowHold = { open: false, isHeld: () => false };

export function createLoadWindow(deps: LoadWindowDeps): LoadWindow {
  const listeners = new Set<() => void>();
  let open = false;
  /** Models not held: complete when the window opened, or settled inside it; not seen loading since. */
  let settled = new Set<string>();
  /** When each loading model was first seen in a terminal state, inside this window. */
  const terminalSince = new Map<string, number>();
  /** Models whose release waits behind a painted frame. */
  const releasing = new Set<string>();
  let snapshot: LoadWindowHold = CLOSED;
  let tailSince = -1;
  let busySince = -1;
  let checkScheduled = false;
  let closeScheduled = false;
  /** Busy periods seen so far, and the one whose store-busy limit timer is armed. */
  let busyPeriod = 0;
  let capArmedFor = -1;

  const publish = (): void => {
    if (!open) snapshot = CLOSED;
    else {
      const frozen = new Set(settled);
      snapshot = { open: true, isHeld: (modelId) => !frozen.has(modelId) };
    }
    for (const listener of [...listeners]) listener();
  };
  const openWindow = (): void => {
    if (open) return;
    settled = new Set();
    for (const [id, state] of deps.modelStates()) if (!LOADING_STATES.has(state)) settled.add(id);
    open = true;
    publish();
  };
  const closeWindow = (): void => {
    if (!open) return;
    open = false;
    settled = new Set();
    terminalSince.clear();
    releasing.clear();
    tailSince = -1;
    publish();
  };
  /**
   * A model that is not held but is seen loading again (a reload) is held from
   * then on. A held model in a terminal state is released once the tail is idle
   * (or its tail limit passed) and a frame has painted; the store's loading
   * flags, which the next load of a multi-file open sets, do not delay it.
   */
  const observeModels = (): void => {
    if (!open) return;
    let changed = false;
    let waiting = false;
    for (const [id, state] of deps.modelStates()) {
      if (LOADING_STATES.has(state)) {
        if (settled.delete(id)) changed = true;
        terminalSince.delete(id);
        releasing.delete(id);
        continue;
      }
      if (settled.has(id) || releasing.has(id)) continue;
      if (!terminalSince.has(id)) terminalSince.set(id, deps.now());
      if (modelTailWaiting(id)) { waiting = true; continue; }
      releaseAfterPaint(id);
    }
    if (changed) publish();
    if (waiting) scheduleCheck();
  };
  const modelTailWaiting = (id: string): boolean =>
    deps.tailBusy() && deps.now() - (terminalSince.get(id) ?? deps.now()) < MAX_TAIL_WAIT_MS;
  // As the window's own close: after the frame that shows the settled model,
  // re-checking the tail, which can start again before that frame.
  const releaseAfterPaint = (id: string): void => {
    releasing.add(id);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (!releasing.delete(id) || !open) return; // seen loading again, or the window closed
      if (modelTailWaiting(id)) { scheduleCheck(); return; }
      settled.add(id);
      publish();
    };
    deps.requestFrame(() => deps.setTimer(finish, 0));
    deps.setTimer(finish, CLOSE_BACKSTOP_MS);
  };
  const busyCapped = (): boolean => busySince >= 0 && deps.now() - busySince >= MAX_STORE_BUSY_MS;
  const tailWaiting = (): boolean => deps.tailBusy() && tailSince >= 0 && deps.now() - tailSince < MAX_TAIL_WAIT_MS;

  const scheduleCheck = (): void => {
    if (checkScheduled) return;
    checkScheduled = true;
    let ran = false;
    const run = (): void => { if (ran) return; ran = true; checkScheduled = false; evaluate(); };
    deps.requestFrame(run);
    deps.setTimer(run, BACKSTOP_MS);
  };
  // One timer per busy period, so each load gets its own limit; a timer left
  // from an earlier load only re-evaluates, which is harmless.
  const scheduleBusyCap = (): void => {
    if (capArmedFor === busyPeriod) return;
    const period = capArmedFor = busyPeriod;
    deps.setTimer(() => {
      if (capArmedFor === period) capArmedFor = -1; // fired early (clock skew): re-arm on this evaluation
      evaluate();
    }, Math.max(0, MAX_STORE_BUSY_MS - (deps.now() - busySince)));
  };
  // Close only after the frame that shows the settled store has painted: the
  // consumers recompute when they are told, and doing that in the same task as
  // the settle put their whole-model walks in front of the first settled frame.
  const closeAfterPaint = (): void => {
    if (closeScheduled) return;
    closeScheduled = true;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      closeScheduled = false;
      if (!open) return;
      if (deps.storeBusy() && !busyCapped()) return; // a new load began meanwhile: still open
      // The tail can start again between the check and this task (a late
      // fragment or shard): re-check it, within the same tail limit.
      if (!deps.storeBusy() && tailWaiting()) { scheduleCheck(); return; }
      closeWindow();
    };
    deps.requestFrame(() => deps.setTimer(finish, 0));
    deps.setTimer(finish, CLOSE_BACKSTOP_MS); // hidden tab: frames stop
  };
  const evaluate = (): void => {
    if (deps.storeBusy()) {
      if (busySince < 0) { busySince = deps.now(); busyPeriod++; }
      if (!busyCapped()) {
        tailSince = -1;
        openWindow();
        observeModels();
        scheduleBusyCap();
        return;
      }
      // Loading for longer than any load: a stuck flag must not hide the values for ever.
      if (open) closeAfterPaint();
      return;
    }
    busySince = -1;
    if (!open) return; // nothing was loading: an idle scene is not a load window
    observeModels();
    if (tailSince < 0) tailSince = deps.now();
    if (tailWaiting()) { scheduleCheck(); return; }
    closeAfterPaint();
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
    isHeld: (modelId) => snapshot.isHeld(modelId),
    hold: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const storeBusy = (s: ViewerState): boolean => s.loading || s.geometryStreamingActive;
function* modelStatesOf(s: ViewerState): Iterable<readonly [string, ModelLoadState]> {
  for (const [id, model] of s.models) yield [id, model.loadState];
}

let viewerLoadWindowInstance: LoadWindow | null = null;
function getViewerLoadWindow(): LoadWindow {
  viewerLoadWindowInstance ??= createLoadWindow({
    storeBusy: () => storeBusy(useViewerStore.getState()),
    modelStates: () => modelStatesOf(useViewerStore.getState()),
    subscribeStore: (listener) => useViewerStore.subscribe((s, prev) => {
      if (storeBusy(s) !== storeBusy(prev) || s.models !== prev.models) listener();
    }),
    tailBusy: isGeometryTailBusy,
    now: () => performance.now(),
    requestFrame: (fn) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn()); else setTimeout(fn, 16); },
    setTimer: (fn, ms) => { setTimeout(fn, ms); },
  });
  return viewerLoadWindowInstance;
}

// Created with this module: the status bar imports it at boot, before any load.
getViewerLoadWindow();

/**
 * The same process-wide window for non-React consumers (the after-load queue):
 * gate whole-viewer work on `isOpen()`, one model's work on `isHeld(modelId)`,
 * and re-check on `subscribe(listener)`. One definition of "settled" for the
 * whole viewer.
 */
export function viewerLoadWindow(): LoadWindow {
  return getViewerLoadWindow();
}

/** The models whose whole-model values wait for the load to settle; closed outside any load. */
export function useLoadWindowHold(): LoadWindowHold {
  const loadWindow = getViewerLoadWindow();
  return useSyncExternalStore(loadWindow.subscribe, loadWindow.hold, () => CLOSED);
}
