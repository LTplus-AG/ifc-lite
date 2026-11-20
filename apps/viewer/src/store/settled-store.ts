/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer-first edits (#10535). An edit publishes its mutation and, a little
 * later, its re-meshed geometry. The scene must take both at once; panels only
 * derive what they show from the session, and re-rendering every panel on
 * the edit's critical path made a single loaded-column move cost a full React
 * render before the re-mesh reply could even be handled.
 *
 * The settled state is the live state, published synchronously, except while
 * an edit is in flight: from a `mutationVersion` change until, after the latest
 * edit, no re-mesh is held, no mesh edit or removal is pending and two frames
 * have passed (at most 250 ms after the window's first edit), or until the
 * user's next input. Then it publishes once. Components
 * read it through the `useViewerStore` hook; a `LiveViewerScope` reads live
 * state (`live-scope.ts` lists what is in one).
 * `getState()` is always live, for writes and staleness checks.
 */

import { flushSync } from 'react-dom';
import type { StoreApi } from 'zustand';
import type { ViewerState } from './index.js';

type SettledApi = Pick<StoreApi<ViewerState>, 'getState' | 'getInitialState' | 'subscribe'>;

/** How long an edit may hold panels back before they publish anyway. */
const SETTLE_CAP_MS = 250;
/** A re-mesh that has not answered by then stops delaying the close. */
const HOLD_LIMIT_MS = 2000;

let holds = 0;
/** Each settled store's hold observer; a hold is process-wide, as re-mesh requests are. */
const onHoldChange = new Set<() => void>();
const holdChanged = () => { for (const observe of onHoldChange) observe(); };

/**
 * Delay an edit's early close while its geometry is being produced (a re-mesh
 * request); the cap still publishes. Returns the release; calling it twice is
 * a no-op, and a hold that is never released ends after `HOLD_LIMIT_MS`.
 */
export function holdSettledState(): () => void {
  holds++;
  holdChanged();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(limit);
    holds--;
    holdChanged();
  };
  const limit = setTimeout(release, HOLD_LIMIT_MS);
  return release;
}

function edgeOf(state: ViewerState): boolean {
  return holds > 0 || state.pendingMeshEdits !== null || state.pendingMeshRemovals !== null;
}

/**
 * Run `publish` after the next frame's callbacks, including any the current
 * store notification is registering (the frame that draws the drained edit).
 */
function afterNextFrame(publish: () => void): void {
  queueMicrotask(() => {
    const frame = globalThis.requestAnimationFrame;
    if (typeof frame === 'function') frame(() => frame(() => setTimeout(publish, 0)));
    else setTimeout(publish, 0);
  });
}

/**
 * Input that a handler may answer with state it read while rendering. Only
 * events that come before the browser changes a control: on `input` or a
 * checkbox `click` the DOM already holds the new value, and a re-render then
 * would write the old controlled value back and swallow the change. No
 * releases: any press inside a window publishes it, so a `keyup` or
 * `pointerup` inside one belongs to the gesture that made the edit (Ctrl+Z,
 * Delete, a drag), and publishing there would render panels on its path.
 */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'beforeinput', 'paste', 'drop', 'contextmenu', 'wheel'] as const;

/** Input and change on a form control: its own edit publishes at once, so it shows the change it made. */
const CONTROL_EVENTS = ['input', 'change', 'click'] as const;
/**
 * Controls whose value the DOM holds: React restores their controlled value
 * right after the handler, so a re-render before it sees the change would
 * write the old value back. They are exempt from publishing on a bare click.
 */
const NATIVE_CONTROL_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';
/** Native controls and the ARIA roles that act as controls (their own edit is published at once too). */
const CONTROL_SELECTOR = `${NATIVE_CONTROL_SELECTOR}, [role="checkbox"], [role="switch"], [role="radio"], [role="option"], `
  + '[role="menuitemcheckbox"], [role="menuitemradio"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="tab"]';

/** The control an event targets, if any, in this window or a popped-out one (no realm-bound instanceof). */
function controlOf(target: EventTarget | null): Element | null {
  const element = target as Partial<Element> | null;
  return element?.nodeType === 1 && typeof element.closest === 'function' ? element.closest(CONTROL_SELECTOR) : null;
}

/** Each settled store's way to watch a window's input. */
const windowObservers = new Set<(win: Window) => void>();

/** Watch input in a window the viewer opened, such as a popped-out panel. */
export function observeWindowInput(win: Window): void {
  for (const observe of windowObservers) observe(win);
}

const settledStores = new WeakMap<StoreApi<ViewerState>, SettledApi>();

/** The settled view of `live`; one per live store within this module instance (a re-evaluated module starts its own). */
export function settledStoreOf(live: StoreApi<ViewerState>): SettledApi {
  let settled = settledStores.get(live);
  if (!settled) settledStores.set(live, settled = createSettledStore(live));
  return settled;
}

function createSettledStore(live: StoreApi<ViewerState>): SettledApi {
  let settled = live.getState();
  // The first edit sets the cap and opens the window. A close token belongs to
  // one pair of frames and is cleared whenever new work restarts that wait.
  let cap: ReturnType<typeof setTimeout> | null = null;
  let close: object | null = null;
  /** The form-control event being dispatched, if any. */
  let controlEvent: Event | null = null;
  const listeners = new Set<(state: ViewerState, previous: ViewerState) => void>();
  const notify = (next: ViewerState) => {
    const previous = settled;
    settled = next;
    for (const listener of listeners) listener(next, previous);
  };

  const publish = () => {
    if (cap !== null) clearTimeout(cap);
    cap = null;
    close = null;
    notify(live.getState());
  };
  const advance = () => {
    if (cap === null || close !== null || edgeOf(live.getState())) return;
    const token = {};
    close = token;
    afterNextFrame(() => {
      if (close !== token) return;
      if (edgeOf(live.getState())) close = null;
      else publish();
    });
  };
  onHoldChange.add(() => { close = null; advance(); });
  // Before React dispatches the event, so no handler answers input with held
  // state; flushSync renders the published state before the handler runs.
  const beforeInput = () => { if (cap !== null) flushSync(publish); };
  const dispatching = () => controlEvent !== null && controlEvent.eventPhase !== Event.NONE;
  const onControl = (event: Event) => {
    const control = controlOf(event.target);
    // A control event dispatched from another's handler leaves the outer one in charge.
    if (control && !dispatching()) controlEvent = event;
    // A click with no pointer press (keyboard, assistive technology, `element.click()`) is input
    // too, unless the DOM already holds a native control's new value. A pressed click's
    // `pointerdown` already published, and an edit its `pointerup` committed (a drag tool) stays held.
    if (event.type === 'click' && (event as MouseEvent).detail === 0 && !control?.matches(NATIVE_CONTROL_SELECTOR)) beforeInput();
  };
  const observe = (win: Window) => {
    for (const type of INPUT_EVENTS) win.addEventListener(type, beforeInput, { capture: true, passive: true });
    for (const type of CONTROL_EVENTS) win.addEventListener(type, onControl, { capture: true, passive: true });
  };
  windowObservers.add(observe);
  if (typeof window !== 'undefined') observe(window);

  live.subscribe((state, previous) => {
    const edited = state.mutationVersion !== previous.mutationVersion;
    // A control's own edit is published at once, as before: React renders it
    // before restoring the control's value, so the change is never undone.
    // With nothing subscribed there is no render to spare, so nothing is held.
    const inControl = dispatching();
    if (inControl || listeners.size === 0) {
      publish();
      return;
    }
    if (cap === null) {
      if (!edited) {
        notify(state);
        return;
      }
      // Panels lag an edit by at most the cap; a re-mesh slower than that lands as an ordinary update.
      cap = setTimeout(publish, SETTLE_CAP_MS);
    } else if (edited || edgeOf(state)) {
      close = null;
    }
    advance();
  });

  return {
    getState: () => settled,
    getInitialState: () => live.getInitialState(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
