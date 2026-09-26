/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5846: a key hint in a mobile nav tooltip must name the key that does that
 * action. The zoom buttons said "Zoom In (+)" / "Zoom Out (-)", but + and −
 * add to and remove from the basket (no key zooms the camera), so following
 * the hint changed the visible set instead of zooming.
 *
 * Mounts the real `ViewportOverlays` in mobile mode, focuses each nav button
 * and reads the tooltip it actually renders. Oracle: the shortcut list the
 * keyboard-shortcuts dialog shows. A hinted key must be bound there, and its
 * action must be the one the tooltip labels.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { KEYBOARD_SHORTCUTS } from '@/hooks/keyboard-shortcuts-list';
import { ViewportOverlays } from './ViewportOverlays';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderMobileOverlays(): HTMLElement {
  useViewerStore.setState({ isMobile: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ViewportOverlays hideViewCube hideAxis hideScale />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

/** Focus the button and return the text of the tooltip it opens. */
function tooltipFor(button: HTMLButtonElement): string {
  act(() => { button.focus(); });
  const tip = document.querySelector('[role="tooltip"]');
  const text = (tip?.textContent ?? '').trim();
  act(() => { button.blur(); });
  return text;
}

const normalizeKey = (key: string) => key.replace('−', '-').toLowerCase();

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.setState({ isMobile: false });
});

describe('mobile nav tooltip key hints (#5846)', () => {
  it('the zoom buttons render tooltips that name no basket key', () => {
    const container = renderMobileOverlays();
    for (const name of ['Zoom in', 'Zoom out']) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
      assert.ok(button, `the mobile nav has no "${name}" button`);
      assert.equal(tooltipFor(button), name, `"${name}" shows a tooltip other than its own name`);
    }
  });

  it('every rendered key hint names a key bound to the action the tooltip labels', () => {
    const container = renderMobileOverlays();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')];
    let hinted = 0;
    for (const button of buttons) {
      const text = tooltipFor(button);
      const hint = /^(.+) \(([^()]+)\)$/.exec(text);
      if (!hint) continue;
      const [, label, key] = hint;
      const shortcut = KEYBOARD_SHORTCUTS.find((s) => normalizeKey(s.key) === normalizeKey(key));
      assert.ok(shortcut, `"${text}" hints ${key}, which no shortcut binds`);
      assert.ok(
        shortcut.description.toLowerCase().startsWith(label.split(' ')[0].toLowerCase()),
        `"${text}" hints ${key}, but ${key} is "${shortcut.description}"`,
      );
      hinted++;
    }
    // "Home (H)" is the one legitimate hint; without it the loop above is vacuous.
    assert.ok(hinted > 0, 'no rendered tooltip carried a key hint: the oracle checked nothing');
  });
});
