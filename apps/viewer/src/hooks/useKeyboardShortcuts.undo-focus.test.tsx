/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ctrl+Z after a pick in a combobox (#6232 M2.5). A Radix Select trigger
 * keeps focus after the user picks a type in the Model inspector; that pick
 * was one undo step, so Ctrl+Z there must undo it. Found in the browser: the
 * press was swallowed because a combobox counts as text entry for SINGLE-key
 * shortcuts. A real text field keeps Ctrl+Z for its own text undo.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, press, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

function Harness() {
  useKeyboardShortcuts();
  return (
    <>
      <Select value="a">
        <SelectTrigger aria-label="Type" data-testid="combo"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="a">A</SelectItem></SelectContent>
      </Select>
      <input aria-label="Name" data-testid="text" />
    </>
  );
}

const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setProperty(MODEL_ID, STOREY, 'Pset_Test', 'A', 'a');
  assert.equal(undoDepth(), 1);
});
afterEach(() => cleanup());

describe('Ctrl+Z focus (#6232 M2.5)', () => {
  it('undoes from a focused Select trigger (a combobox button)', () => {
    const root = render(<Harness />);
    const combo = root.querySelector<HTMLElement>('[data-testid="combo"]')!;
    assert.equal(combo.getAttribute('role'), 'combobox');
    combo.focus();
    press(combo, 'z', { ctrlKey: true });
    assert.equal(undoDepth(), 0);
  });

  it('leaves Ctrl+Z to a focused text field', () => {
    const root = render(<Harness />);
    const text = root.querySelector<HTMLElement>('[data-testid="text"]')!;
    text.focus();
    press(text, 'z', { ctrlKey: true });
    assert.equal(undoDepth(), 1);
  });
});
