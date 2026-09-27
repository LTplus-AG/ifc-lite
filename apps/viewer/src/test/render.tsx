/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One `render()` for viewer component tests (#2434).
 *
 * `DxfUnderlayPanel.test.tsx` and `export-ui-parity.test.tsx` had each grown
 * their own copy of the same twelve lines (container + `createRoot` + `act` +
 * a `mounted[]` array unmounted in `afterEach`). This is that, once, with the
 * `TooltipProvider` wrapper the Radix-based controls need in order to render at
 * all.
 *
 * Import `./setup-dom.js` FIRST in the test file — before this module and
 * before anything that pulls in `react-dom`. See that file for why.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/**
 * Mount `node` into a fresh detached-then-appended container and return it.
 * Every mount is tracked; call {@link cleanup} from `afterEach`.
 */
export function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  mounted.push({ root, container });
  return container;
}

/** Unmount everything {@link render} mounted. Safe to call when nothing is mounted. */
export function cleanup(): void {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
}

/**
 * Dispatch a real bubbling click, the way a user's click arrives at React's
 * root listener. `element.click()` works too, but this keeps modifier-key
 * variants (additive selection) expressible in the same call.
 */
export function click(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * Dispatch a real bubbling `mousedown`. Popover rows commit on `mousedown`
 * rather than `click` so the commit beats the input's `blur`, which would tear
 * the popover down first — for those, this IS the user's press.
 */
export function mouseDown(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * Dispatch a real bubbling `keydown`. Components that install a `window`
 * keydown listener are driven by passing `window` as the target.
 *
 * The `act()` wrapper is load-bearing rather than tidy: a keystroke that lands
 * in a Zustand store re-renders the subscriber, and the EFFECT that reacts to
 * the new state does not run until React flushes. Without it a test reads the
 * state from before the effect and reports "the handler did nothing".
 */
export function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/**
 * Activate a focused control as a browser does. Happy DOM dispatches the key
 * events but omits the native button's default click, so supply that default
 * only for buttons whose keydown was not cancelled. Custom roles must handle
 * their own keydown; this helper never clicks them on their behalf.
 */
export function activate(target: HTMLElement, key: 'Enter' | ' ' = 'Enter'): void {
  target.focus();
  act(() => {
    const down = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    const proceed = target.dispatchEvent(down);
    target.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    if (proceed && target instanceof window.HTMLButtonElement) target.click();
  });
}

/**
 * Dispatch the event that arrives at React's `onBlur`. `blur` itself does
 * not bubble (DOM spec), so React delegates it from the ROOT via the
 * bubbling `focusout` instead — dispatching `blur` here would bubble
 * nowhere and never reach React's listener at all. Wrapped in `act()` for
 * the same reason `press` is: a blur-driven commit into a store
 * re-renders subscribers, and an unwrapped dispatch reads their state from
 * before React flushed it.
 */
export function blur(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
}

/**
 * Type into a controlled input or textarea the way a user does.
 *
 * Assigning `.value` directly leaves React's internal value tracker believing
 * nothing changed, so `onChange` never fires and the field silently stays
 * empty — a test that then asserts on the result passes or fails for the wrong
 * reason. Going through the prototype setter is what makes React notice.
 */
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on the element prototype');
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/**
 * Advance React past a `setTimeout(..., ms)` scheduled by the code under test.
 * Several selection paths frame the camera on a trailing timer.
 */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Let React and the code under test run until `done()` holds, then return.
 *
 * For async work whose duration is not the test's business (lazy module loads,
 * real reprojection, a handler's `await` chain): the wait ends on the
 * condition, not on a tick count. A fixed budget such as 50 x 5 ms passes when
 * the file runs alone and fails once the runner is loaded (#5977). The
 * deadline is only a safety net for a condition that will never hold; it
 * throws `message`, so a real regression fails here, by name, instead of at
 * whichever assertion happens to read the state next.
 */
export async function waitFor(
  done: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: gave up after ${timeoutMs} ms: ${message}`);
    }
    await advance(5);
  }
}
