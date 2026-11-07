/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The running command's fields, typed into the way a user does (#9094): a digit
 * typed into the viewport starts the first field, Tab moves to the next, and
 * what is typed there replaces what the field showed.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, press, render, type } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { resetGridSettings } from '@/lib/commands/modeling/commands/grid-place-geometry';
import type { SnapResult } from '@/lib/snap/types';
import { CommandFieldsBar } from './CommandFieldsBar';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift: false, alt: false } });
const open = () => document.querySelector('input') as HTMLInputElement;
/** What a browser does with a key: the text replaces the selection, or lands at the caret. */
function keys(text: string): void {
  const el = open();
  type(el, el.value.slice(0, el.selectionStart ?? 0) + text + el.value.slice(el.selectionEnd ?? 0));
}
function live(entityType: string) {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === entityType && !view.isDeleted(e.expressId));
}

let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  resetGridSettings();
  restoreRemesh = setRequestRemesh(() => {});
  useViewerStore.getState().startCommand('grid.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('CommandFieldsBar (#9094)', () => {
  it('grid corner, 18, Tab, 12, Enter: each value replaces what its field showed, and the grid commits', () => {
    render(<CommandFieldsBar />);
    act(() => { commandPointerMove(at(1, 1)); commandPointerDown(at(1, 1)); });
    press(document.body, '1');
    keys('8');
    assert.equal(open().value, '18');

    press(open(), 'Tab');
    assert.equal(open().getAttribute('aria-label'), 'Depth');
    keys('12');
    assert.equal(open().value, '12');

    press(open(), 'Enter');
    assert.equal(live('IFCGRID').length, 1);
    // 18 m at 6 m: four axes across; 12 m at 6 m: three down.
    assert.equal(live('IFCGRIDAXIS').length, 7);
  });
});
