/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's named-cut menu (#5514): save the live cut, list saved
 * cuts, apply/rename/delete one. Asserted on the OUTPUT — menu contents and
 * the store after each action — never on the wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, type as typeInput, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import { useViewerStore } from '@/store';
import { useSavedSectionCuts, saveCurrentSectionCut } from '@/store/savedSectionCutsStore';
import { DrawingSectionCutMenu } from './DrawingSectionCutMenu.js';

const s = () => useViewerStore.getState();

function openMenu(): void {
  const trigger = document.querySelector<HTMLElement>('button[aria-label^="Section source:"]')!;
  act(() => { trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); });
  click(trigger);
}

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-testid="saved-section-cut-row"]')];
}

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select',
    sectionPlane: { ...s().sectionPlane, axis: 'down', position: 50, flipped: false, custom: undefined },
  });
  useSavedSectionCuts.setState({ cuts: [], activeCutId: null });
});

afterEach(() => {
  cleanup();
});

describe('DrawingSectionCutMenu (#5514)', () => {
  it('shows the empty state with no saved cuts', () => {
    render(<DrawingSectionCutMenu cutLabel="Down 50.0" />);
    openMenu();
    assert.equal(rows().length, 0);
    assert.ok(document.body.textContent?.includes('No saved cuts yet'));
  });

  it('lists a saved cut and applies it on click, opening the Section tool', () => {
    act(() => { s().setActiveTool('section'); });
    act(() => { s().setSectionPlaneAxis('front'); s().setSectionPlanePosition(37); });
    const id = saveCurrentSectionCut('Front cut');
    act(() => { s().setActiveTool('select'); s().setSectionPlaneAxis('down'); s().setSectionPlanePosition(50); });

    render(<DrawingSectionCutMenu cutLabel="Down 50.0" />);
    openMenu();
    const row = rows().find((r) => r.textContent?.includes('Front cut'));
    assert.ok(row, 'the saved cut is listed');
    click(row!.querySelector('button')!);

    assert.equal(s().activeTool, 'section');
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.position, 37);
    assert.equal(useSavedSectionCuts.getState().activeCutId, id);
  });

  it('deletes a saved cut from its row', () => {
    saveCurrentSectionCut('Doomed cut');
    render(<DrawingSectionCutMenu cutLabel="Down 50.0" />);
    openMenu();
    const row = rows().find((r) => r.textContent?.includes('Doomed cut'))!;
    const deleteButton = row.querySelector('button[title="Delete saved cut"]')!;
    click(deleteButton);
    assert.equal(useSavedSectionCuts.getState().cuts.length, 0);
  });

  it('"Save current cut as..." names the live cut via the menu\'s own prompt', async () => {
    const { ConfirmDialogHost } = await loadDialogs();
    render(<><DrawingSectionCutMenu cutLabel="Down 50.0" /><ConfirmDialogHost /></>);
    openMenu();
    click([...document.body.querySelectorAll('div')].find((el) => el.textContent === 'Save current cut as…')!);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    typeInput(dialog.querySelector('input')!, 'From the menu');
    click(dialog.querySelector('button[type="submit"]')!);
    await waitFor(() => useSavedSectionCuts.getState().cuts.some((c) => c.name === 'From the menu'), 'named cut is saved');
  });

  it('renames a saved cut via its row\'s prompt', async () => {
    const { ConfirmDialogHost } = await loadDialogs();
    const id = saveCurrentSectionCut('Before');
    render(<><DrawingSectionCutMenu cutLabel="Down 50.0" /><ConfirmDialogHost /></>);
    openMenu();
    const row = rows().find((r) => r.textContent?.includes('Before'))!;
    click(row.querySelector('button[title="Rename saved cut"]')!);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    typeInput(dialog.querySelector('input')!, 'After');
    click(dialog.querySelector('button[type="submit"]')!);
    await waitFor(() => useSavedSectionCuts.getState().cuts.find((c) => c.id === id)?.name === 'After', 'saved cut is renamed');
  });
});
