/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Esc does one step per press and never resets visibility (#5595).
 *
 * Mounts the REAL `useKeyboardShortcuts()` hook against the shared store and
 * presses Escape on `window`. Before the fix every Esc also ran the Home
 * visibility reset, so a hand-built isolation, hidden set or basket was lost
 * whenever the user left a tool or cleared a selection.
 */

import '@/test/setup-dom.js';
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useViewerStore } from '@/store';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

/** Mount the hook, press Escape `presses` times in quick succession, unmount. */
async function pressEscape(presses = 1, init: KeyboardEventInit & { consumed?: boolean } = {}): Promise<void> {
  const { consumed = false, ...eventInit } = init;
  function Harness(): null {
    useKeyboardShortcuts();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    for (let i = 0; i < presses; i++) {
      await act(async () => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...eventInit });
        // A layer between the key and this window listener (a Radix popover's
        // document-capture Escape handler) marks the event handled.
        if (consumed) event.preventDefault();
        window.dispatchEvent(event);
      });
    }
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

describe('Esc keyboard shortcut (#5595)', () => {
  beforeEach(() => { useViewerStore.setState(originalState, true); });

  it('keeps an isolation when leaving a tool', async () => {
    const s = useViewerStore.getState();
    s.isolateEntities([1, 2, 3]);
    s.setActiveTool('measure');

    await pressEscape();

    const after = useViewerStore.getState();
    assert.deepEqual([...(after.isolatedEntities ?? [])].sort(), [1, 2, 3]);
    assert.equal(after.activeTool, 'select');
  });

  it('keeps hidden entities and the basket when clearing the selection', async () => {
    const s = useViewerStore.getState();
    s.hideEntities([5, 6]);
    s.setBasket([{ modelId: 'legacy', expressId: 7 }]);
    const basketBefore = useViewerStore.getState().pinboardEntities.size;
    assert.ok(basketBefore > 0, 'basket seed did not take');
    s.setSelectedEntityIds([8, 9]);
    s.setSelectedEntityId(8);

    await pressEscape();

    const after = useViewerStore.getState();
    assert.equal(after.hiddenEntities.size, 2);
    assert.equal(after.pinboardEntities.size, basketBefore);
    assert.equal(after.selectedEntityId, null);
    assert.equal(after.selectedEntityIds.size, 0);
  });

  it('leaves the tool first and keeps the selection for the next press', async () => {
    const s = useViewerStore.getState();
    s.setActiveTool('section');
    s.setSelectedEntityId(4);

    await pressEscape();

    const after = useViewerStore.getState();
    assert.equal(after.activeTool, 'select');
    assert.equal(after.selectedEntityId, 4);
  });

  it('Esc Esc closes panels without resetting visibility', async () => {
    const s = useViewerStore.getState();
    s.isolateEntities([1, 2]);
    s.hideEntities([3]);

    await pressEscape(2);

    const after = useViewerStore.getState();
    assert.deepEqual([...(after.isolatedEntities ?? [])].sort(), [1, 2]);
    assert.equal(after.hiddenEntities.size, 1);
  });

  it('an Escape another layer already consumed leaves the tool open (#5499 Cap popover)', async () => {
    useViewerStore.getState().setActiveTool('section');

    await pressEscape(1, { consumed: true });
    assert.equal(useViewerStore.getState().activeTool, 'section', 'a popover dismissing itself must not also close the tool');

    await pressEscape();
    assert.equal(useViewerStore.getState().activeTool, 'select', 'an unconsumed Escape still leaves the tool');
  });
});
