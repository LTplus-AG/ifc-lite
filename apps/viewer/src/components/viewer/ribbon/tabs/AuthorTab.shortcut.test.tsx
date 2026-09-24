/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ribbon's Undo/Redo tooltips name the keys for the platform they run on
 * (#5836): `⌘Z` was typed into the tooltip by hand, so Windows and Linux
 * users were told to press a key they do not have.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { setPlatform } from '@/test/platform.js';
import { AuthorTab } from './AuthorTab.js';

const historyEntry = { id: 'r', timestamp: 0, before: new Map(), after: new Map() };

beforeEach(() => {
  // One step each way, so both buttons are enabled (a disabled button cannot
  // take focus, and focus is what opens a Radix tooltip).
  useViewerStore.setState({ referenceUndo: [historyEntry], referenceRedo: [historyEntry] });
});

afterEach(() => {
  cleanup();
  setPlatform(null);
  useViewerStore.setState({ referenceUndo: [], referenceRedo: [] });
});

function tooltipFor(label: string): string {
  const button = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `the ${label} button rendered`);
  act(() => button.focus());
  const tooltip = document.body.querySelector('[role="tooltip"]');
  assert.ok(tooltip, `focusing ${label} opened its tooltip`);
  return tooltip.textContent ?? '';
}

describe('ribbon Undo/Redo key hints (#5836)', () => {
  it('say Ctrl+Z / Ctrl+Shift+Z off Apple platforms', () => {
    setPlatform('Win32');
    render(<AuthorTab />);
    assert.match(tooltipFor('Undo'), /\(Ctrl\+Z\)/);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.match(tooltipFor('Redo'), /\(Ctrl\+Shift\+Z\)/);
  });

  it('say ⌘Z / ⇧⌘Z on Apple platforms', () => {
    setPlatform('MacIntel');
    render(<AuthorTab />);
    assert.match(tooltipFor('Undo'), /\(⌘Z\)/);
  });
});
