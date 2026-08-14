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
 * Advance React past a `setTimeout(..., ms)` scheduled by the code under test.
 * Several selection paths frame the camera on a trailing timer.
 */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
