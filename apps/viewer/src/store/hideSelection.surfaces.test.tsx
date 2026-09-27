/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Hide selection" does the same thing on every surface (#5852): it hides
 * every selected entity and clears the selection. Before, the keyboard kept
 * the (invisible) selection, the mobile toolbar hid only the primary entity,
 * and the context menu hid only the right-clicked entity.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, press, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts.js';
import { ElementsTab } from '@/components/viewer/ribbon/tabs/ElementsTab.js';
import { MainToolbar } from '@/components/viewer/MainToolbar.js';
import { MobileToolbar } from '@/components/viewer/MobileToolbar.js';
import { EntityContextMenu } from '@/components/viewer/EntityContextMenu.js';

const A = 1_000_001;
const B = 1_000_002;
const OUTSIDE = 1_000_003;

let initialState: ReturnType<typeof useViewerStore.getState>;

function KeyboardHarness() {
  useKeyboardShortcuts();
  return null;
}

/** Two entities selected, A the primary, as a Ctrl+click multi-select leaves it. */
function selectTwo() {
  useViewerStore.setState({ selectedEntityId: A, selectedEntityIds: new Set([A, B]) });
}

function assertBothHiddenAndSelectionCleared(surface: string) {
  const state = useViewerStore.getState();
  assert.deepEqual([...state.hiddenEntities].sort(), [A, B], `${surface}: hides every selected entity`);
  assert.equal(state.selectedEntityId, null, `${surface}: clears the primary selection`);
  assert.equal(state.selectedEntityIds.size, 0, `${surface}: clears the multi-selection`);
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `a button labelled "${label}"`);
  return button;
}

/** Radix menus open on pointerdown, then click (AGENTS.md). */
function openRadixMenu(trigger: Element) {
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

describe('Hide selection is one command on every surface (#5852)', () => {
  beforeEach(() => {
    initialState = useViewerStore.getState();
    selectTwo();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useViewerStore.setState(initialState, true);
  });

  for (const key of ['Delete', 'Backspace', ' ']) {
    it(`keyboard ${JSON.stringify(key)}`, () => {
      render(<KeyboardHarness />);
      press(window, key);
      assertBothHiddenAndSelectionCleared(`key ${JSON.stringify(key)}`);
    });
  }

  it('keyboard Delete with only a multi-selection (no primary) still hides it', () => {
    useViewerStore.setState({ selectedEntityId: null });
    render(<KeyboardHarness />);
    press(window, 'Delete');
    assertBothHiddenAndSelectionCleared('Delete, multi-selection only');
  });

  it('ribbon Elements tab', () => {
    render(<ElementsTab />);
    click(buttonByLabel('Hide selection'));
    assertBothHiddenAndSelectionCleared('ribbon');
  });

  it('classic toolbar', () => {
    render(<MainToolbar />);
    click(buttonByLabel('Hide Selection'));
    assertBothHiddenAndSelectionCleared('classic toolbar');
  });

  it('mobile toolbar overflow menu', () => {
    render(<MobileToolbar />);
    const trigger = document.body.querySelector('button[aria-haspopup="menu"]');
    assert.ok(trigger, 'the overflow menu trigger rendered');
    openRadixMenu(trigger);
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === 'Hide Selection');
    assert.ok(item, 'the Hide Selection item is in the menu');
    click(item);
    assertBothHiddenAndSelectionCleared('mobile toolbar');
  });

  it('mobile toolbar Hide is enabled for a multi-selection with no primary', () => {
    useViewerStore.setState({ selectedEntityId: null });
    render(<MobileToolbar />);
    const trigger = document.body.querySelector('button[aria-haspopup="menu"]');
    assert.ok(trigger, 'the overflow menu trigger rendered');
    openRadixMenu(trigger);
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === 'Hide Selection');
    assert.ok(item, 'the Hide Selection item is in the menu');
    assert.equal(item.getAttribute('aria-disabled'), null, 'Hide is enabled');
    click(item);
    assertBothHiddenAndSelectionCleared('mobile toolbar, multi-selection only');
  });

  it('context menu opened on a selected entity hides the whole selection', () => {
    act(() => { useViewerStore.getState().openContextMenu(B, 10, 10); });
    render(<EntityContextMenu />);
    const item = [...document.body.querySelectorAll('button')].find((b) => b.querySelector('span')?.textContent?.trim() === 'Hide');
    assert.ok(item, 'the Hide item rendered');
    click(item);
    assertBothHiddenAndSelectionCleared('context menu');
  });

  it('context menu opened outside the selection hides only that entity (control)', () => {
    act(() => { useViewerStore.getState().openContextMenu(OUTSIDE, 10, 10); });
    render(<EntityContextMenu />);
    const item = [...document.body.querySelectorAll('button')].find((b) => b.querySelector('span')?.textContent?.trim() === 'Hide');
    assert.ok(item, 'the Hide item rendered');
    click(item);
    const state = useViewerStore.getState();
    assert.deepEqual([...state.hiddenEntities], [OUTSIDE]);
    assert.deepEqual([...state.selectedEntityIds].sort(), [A, B], 'the selection is untouched');
  });
});
