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
 * released when ITS OWN load has ended: the loader marks that point
 * (`markModelLoadEnded`, at the settle of that load's UI: after finalize and
 * publication), then the geometry tail must be idle (or `MAX_TAIL_WAIT_MS` must
 * have passed since the mark), then the viewport must have drawn the settled
 * scene (`afterSettledFrame`, lib/settled-frame.ts). For a single load that
 * is the same point as the window's own close. The record turning `complete`
 * is not that point (on a cache hit it is ~400 ms earlier), and another
 * model's load does not extend it: in a multi-file open the next file's load
 * does not keep an earlier, ended model held. In single-store mode the store
 * is the one being loaded, so `legacy` is held until the window closes.
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
import { subscribeModelLoadEnded } from './modelLoadEnd.js';
import { afterSettledFrame, viewerRequestFrame, type AfterSettledFrame } from '@/lib/settled-frame';

export const MAX_TAIL_WAIT_MS = 3_000;
export const MAX_STORE_BUSY_MS = 30_000;
const BACKSTOP_MS = 100;

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
  /** Subscribe to the loader's per-model "load ended" mark (modelLoadEnd.ts). */
  subscribeLoadEnded: (listener: (modelId: string) => void) => () => void;
  tailBusy: () => boolean;
  now: () => number;
  requestFrame: (fn: () => void) => void;
  setTimer: (fn: () => void, ms: number) => void;
  /** Run a release once the settled scene has been drawn (lib/settled-frame.ts). */
  afterSettledFrame: AfterSettledFrame;
}

/** What the window holds right now; a new object whenever that changes. */
export interface LoadWindowHold {
  /** True from a load's start until its scene settles. */
  readonly open: boolean;
  /**
   * True while this model's whole-model values must wait: the window is open and
   * the model has not settled. `legacy` (the single store, or a caller with no
   * model id to ask about) is held only while no real model is registered.
   */
  isHeld(modelId: string): boolean;
}

export interface LoadWindow {
  isOpen: () => boolean;
  isHeld: (modelId: string) => boolean;
  hold: () => LoadWindowHold;
  subscribe: (listener: () => void) => () => void;
}

const CLOSED: LoadWindowHold = { open: false, isHeld: () => false };
/** The id consumers use for the single store, or when they have no model id to ask about. */
const LEGACY_ID = 'legacy';

export function createLoadWindow(deps: LoadWindowDeps): LoadWindow {
  const listeners = new Set<() => void>();
  let open = false;
  /** Models not held: complete when the window opened, or settled inside it; not seen loading since. */
  let settled = new Set<string>();
  /** When the loader marked each model's load as ended, inside this window. */
  const loadEndedAt = new Map<string, number>();
  /** Models whose release waits for the settled scene to be drawn. */
  const releasing = new Set<string>();
  /**
   * Real models are registered and none is called `legacy`: then `legacy` names
   * no load (a caller with no model id to ask about), so it is not held. Only
   * in single-store mode is `legacy` the store that is loading.
   */
  let legacyFree = false;
  const computeLegacyFree = (): boolean => {
    let any = false;
    for (const [id] of deps.modelStates()) { if (id === LEGACY_ID) return false; any = true; }
    return any;
  };
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
      const legacyNotHeld = legacyFree;
      snapshot = { open: true, isHeld: (modelId) => !frozen.has(modelId) && !(legacyNotHeld && modelId === LEGACY_ID) };
    }
    for (const listener of [...listeners]) listener();
  };
  const openWindow = (): void => {
    if (open) return;
    settled = new Set();
    for (const [id, state] of deps.modelStates()) if (!LOADING_STATES.has(state)) settled.add(id);
    loadEndedAt.clear(); // a mark from before this window belongs to a finished load
    legacyFree = computeLegacyFree();
    open = true;
    publish();
  };
  const closeWindow = (): void => {
    if (!open) return;
    open = false;
    settled = new Set();
    loadEndedAt.clear();
    releasing.clear();
    tailSince = -1;
    publish();
  };
  /**
   * A model that is not held but is seen loading again (a reload) is held from
   * then on. A held model whose load the loader has marked ended is released
   * once the tail is idle (or its tail limit passed) and the settled scene has been drawn;
   * the store's loading flags, which the next load of a multi-file open sets,
   * do not delay it.
   */
  const observeModels = (): void => {
    if (!open) return;
    let changed = false;
    let waiting = false;
    const nextLegacyFree = computeLegacyFree();
    if (nextLegacyFree !== legacyFree) { legacyFree = nextLegacyFree; changed = true; }
    for (const [id, state] of deps.modelStates()) {
      if (LOADING_STATES.has(state)) {
        if (settled.delete(id)) changed = true;
        loadEndedAt.delete(id); // a new load of this model is in progress
        releasing.delete(id);
        continue;
      }
      if (settled.has(id) || releasing.has(id) || !loadEndedAt.has(id)) continue;
      if (modelTailWaiting(id)) { waiting = true; continue; }
      releaseAfterSettledFrame(id);
    }
    if (changed) publish();
    if (waiting) scheduleCheck();
  };
  const modelTailWaiting = (id: string): boolean =>
    deps.tailBusy() && deps.now() - (loadEndedAt.get(id) ?? deps.now()) < MAX_TAIL_WAIT_MS;
  // As the window's own close: after the settled model has been drawn,
  // re-checking the tail, which can start again before that frame.
  const releaseAfterSettledFrame = (id: string): void => {
    releasing.add(id);
    const finish = (): void => {
      if (!releasing.delete(id) || !open) return; // seen loading again, or the window closed
      if (modelTailWaiting(id)) { scheduleCheck(); return; }
      settled.add(id);
      publish();
    };
    deps.afterSettledFrame(finish);
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
  // Close only after the viewport has drawn the settled scene: the
  // consumers recompute when they are told, and doing that in the same task as
  // the settle put their whole-model walks in front of the first settled frame.
  const closeAfterSettledFrame = (): void => {
    if (closeScheduled) return;
    closeScheduled = true;
    const finish = (): void => {
      closeScheduled = false;
      if (!open) return;
      if (deps.storeBusy() && !busyCapped()) return; // a new load began meanwhile: still open
      // The tail can start again between the check and this task (a late
      // fragment or shard): re-check it, within the same tail limit.
      if (!deps.storeBusy() && tailWaiting()) { scheduleCheck(); return; }
      closeWindow();
    };
    deps.afterSettledFrame(finish); // its backstop covers a hidden tab, where frames stop
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
      if (open) closeAfterSettledFrame();
      return;
    }
    busySince = -1;
    if (!open) return; // nothing was loading: an idle scene is not a load window
    observeModels();
    if (tailSince < 0) tailSince = deps.now();
    if (tailWaiting()) { scheduleCheck(); return; }
    closeAfterSettledFrame();
  };

  // Observe the store from creation, not only while a consumer is subscribed:
  // a consumer mounted after the store flags cleared, while the drain or
  // finalize still runs, must still see the window open. The viewer creates the
  // window when its first consumer module loads (the status bar, at boot), so
  // every load is seen from its start.
  deps.subscribeStore(evaluate);
  deps.subscribeLoadEnded((modelId) => {
    if (!open) return;
    loadEndedAt.set(modelId, deps.now());
    evaluate();
  });
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
    subscribeLoadEnded: subscribeModelLoadEnded,
    tailBusy: isGeometryTailBusy,
    now: () => performance.now(),
    requestFrame: viewerRequestFrame,
    setTimer: (fn, ms) => { setTimeout(fn, ms); },
    afterSettledFrame,
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
