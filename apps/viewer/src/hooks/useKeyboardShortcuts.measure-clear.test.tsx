/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure tool: no keyboard shortcut wipes every measurement (#5598).
 *
 * Measurements are not part of workspace undo, so a clear is unrecoverable.
 * Ctrl/Cmd+C used to clear them (a user copying a value out of the panel lost
 * everything), and so did Delete/Backspace with no entity selected. Clearing
 * is now only the panel's explicit "Clear all" button, behind a confirm.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import { useViewerStore } from '@/store/index.js';
import type { Measurement } from '@/store/types.js';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';
import { MeasureOverlay } from '@/components/viewer/tools/MeasurePanel.js';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud.js';

function ShortcutsHost() {
  useKeyboardShortcuts();
  return null;
}

const point = (x: number) => ({ x, y: 0, z: 0, screenX: x, screenY: 0 });
const MEASUREMENT: Measurement = { id: 'm1', start: point(0), end: point(2), distance: 2 };

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'measure',
    selectedEntityId: null,
    measurements: [MEASUREMENT],
    activeMeasurement: null,
    activePolyline: null,
    activeAngle: null,
    activeRadius: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('Measure tool keyboard shortcuts do not clear measurements (#5598)', () => {
  it('Ctrl+C keeps every measurement', () => {
    render(<ShortcutsHost />);
    press('c', { ctrlKey: true });
    assert.deepEqual(useViewerStore.getState().measurements, [MEASUREMENT]);
  });

  it('Cmd+C keeps every measurement', () => {
    render(<ShortcutsHost />);
    press('c', { metaKey: true });
    assert.deepEqual(useViewerStore.getState().measurements, [MEASUREMENT]);
  });

  it('Delete and Backspace with nothing selected keep every measurement', () => {
    render(<ShortcutsHost />);
    press('Delete');
    press('Backspace');
    assert.deepEqual(useViewerStore.getState().measurements, [MEASUREMENT]);
  });
});

describe('Measure bar "Clear all" asks before clearing (#5598)', () => {
  function clearAllButton(container: HTMLElement): Element {
    const button = container.querySelector('button[title="Clear all"]');
    assert.ok(button, 'measure bar has no "Clear all" button');
    return button;
  }

  /** The bar portals into the HUD host (#5502), so both mount together. */
  const renderBar = async () => {
    const { ConfirmDialogHost } = await loadDialogs();
    return render(<><ViewportHud /><MeasureOverlay /><ConfirmDialogHost /></>);
  };

  it('keeps the measurements when the confirm is declined', async () => {
    const container = await renderBar();
    click(clearAllButton(container));
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /Clear every measurement\? This cannot be undone\./);
    click(dialog.querySelector('button')!);
    assert.deepEqual(useViewerStore.getState().measurements, [MEASUREMENT]);
  });

  it('clears the measurements when the confirm is accepted', async () => {
    const container = await renderBar();
    click(clearAllButton(container));
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    click(dialog.querySelectorAll('button')[1]);
    await waitFor(() => useViewerStore.getState().measurements.length === 0, 'accepted clear removes measurements');
    assert.deepEqual(useViewerStore.getState().measurements, []);
  });
});
