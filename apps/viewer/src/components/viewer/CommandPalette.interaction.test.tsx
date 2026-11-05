/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, click, press, render, type as typeInto } from '@/test/render.js';
import { CommandPalette } from './CommandPalette.js';
import { RECENT_KEY } from './commandPaletteSearch.js';

const originalState = useViewerStore.getState();
beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  useViewerStore.setState({ collabRole: null, cesiumAvailable: true });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  useViewerStore.setState(originalState);
});

function mount(onOpenChange: (open: boolean) => void = () => {}) {
  render(<BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open onOpenChange={onOpenChange} />
  </BimReactContext.Provider>);
  const input = document.querySelector<HTMLInputElement>('input');
  assert.ok(input);
  input.focus();
  return input;
}

function rows() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

function active(input: HTMLInputElement) {
  const id = input.getAttribute('aria-activedescendant');
  assert.ok(id, 'a nonempty list has an active descendant');
  const row = document.getElementById(id);
  assert.ok(row, 'the active descendant is mounted');
  assert.equal(row.getAttribute('role'), 'option');
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.equal(rows().filter(row => row.getAttribute('aria-selected') === 'true').length, 1);
  return row;
}

function hover(row: HTMLElement) {
  act(() => row.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true })));
}

test('combobox owns stable unique options, including recents, and retains focus (#8946)', () => {
  localStorage.setItem(RECENT_KEY, JSON.stringify(['view:home']));
  const input = mount();
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(input.getAttribute('aria-autocomplete'), 'list');
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
  assert.equal(list?.getAttribute('role'), 'listbox');
  const initialRows = rows();
  assert.equal(new Set(initialRows.map(row => row.id)).size, initialRows.length);
  assert.ok(initialRows.every(row => row.id && row.tabIndex === -1));
  // Native Tab traversal is verified in the browser scenario; Happy DOM does
  // not perform the browser's default traversal after a dispatched keydown.
  const homes = initialRows.filter(row => row.dataset.commandId === 'view:home');
  assert.equal(homes.length, 2, 'recent and category occurrences both render');
  assert.notEqual(homes[0].id, homes[1].id);
  const categoryHomeId = homes[1].id;
  press(input, 'ArrowDown');
  assert.equal(active(input), initialRows[1]);
  assert.equal(document.activeElement, input);
  hover(homes[1]);
  assert.equal(active(input), homes[1]);
  act(() => {
    const proceed = homes[1].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    // Model the browser's focus default, which Happy DOM does not perform.
    if (proceed) homes[1].focus();
  });
  assert.equal(document.activeElement, input, 'pointer selection keeps typing in the search');
  typeInto(input, 'Home');
  assert.equal(rows().find(row => row.dataset.commandId === 'view:home')?.id, categoryHomeId);
  typeInto(input, '');
  assert.equal(rows().find(row => row.id === categoryHomeId)?.dataset.commandId, 'view:home');
});

test('empty results recover safely and whitespace browses categories (#8946)', () => {
  let closes = 0;
  const input = mount(() => { closes++; });
  const browseIds = rows().map(row => row.id);
  typeInto(input, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.equal(rows().length, 0);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) press(input, key);
  assert.equal(input.hasAttribute('aria-activedescendant'), false);
  assert.equal(closes, 0);
  typeInto(input, ' \t  ');
  assert.deepEqual(rows().map(row => row.id), browseIds);
  assert.ok(document.querySelector('[data-command-category="File"]'));
  assert.equal(active(input), rows()[0]);
  press(input, 'ArrowUp');
  assert.equal(active(input), rows()[0]);
  hover(rows().at(-1)!);
  press(input, 'ArrowDown');
  assert.equal(active(input), rows().at(-1));
});

test('live command changes preserve surviving selection and recover a removed selection (#8946)', () => {
  const input = mount();
  const lighting = rows().find(row => row.dataset.commandId === 'view:lighting');
  const world = rows().find(row => row.dataset.commandId === 'view:world');
  assert.ok(lighting && world);
  hover(lighting);
  act(() => useViewerStore.setState({ cesiumAvailable: false }));
  assert.equal(active(input).id, lighting.id, 'removing an earlier command does not shift selection');
  act(() => useViewerStore.setState({ cesiumAvailable: true }));
  hover(document.getElementById(world.id)!);
  act(() => useViewerStore.setState({ cesiumAvailable: false }));
  assert.equal(active(input), rows()[0], 'a removed command falls back to the first valid item');
  act(() => useViewerStore.setState({ cesiumAvailable: true }));
  assert.equal(active(input), rows()[0], 'reappearing commands do not steal selection');
});

test('IME confirmation cannot run commands; ordinary Enter and click keep file activation synchronous (#8946)', () => {
  let opened = 0;
  let closes = 0;
  const onFiles = () => { opened++; };
  window.addEventListener('ifc-lite:open-files', onFiles);
  try {
    const input = mount(() => { closes++; });
    hover(rows().find(row => row.dataset.commandId === 'file:open')!);
    press(input, 'Enter', { isComposing: true });
    press(input, 'Enter', { keyCode: 229 });
    assert.equal(opened, 0);
    assert.equal(closes, 0);
    press(input, 'Enter');
    assert.equal(opened, 1, 'file picker opens before the key handler returns');
    assert.equal(closes, 1);
    assert.equal(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')[0], 'file:open');
    click(rows().find(row => row.dataset.commandId === 'file:open')!);
    assert.equal(opened, 2, 'pointer activation is synchronous too');
  } finally {
    window.removeEventListener('ifc-lite:open-files', onFiles);
  }
});


test('whitespace preserves the resolved selection when a recent command appears (#8946)', () => {
  localStorage.setItem(RECENT_KEY, JSON.stringify(['view:world', 'view:lighting']));
  useViewerStore.setState({ cesiumAvailable: false });
  const input = mount();
  const initial = active(input).id;
  typeInto(input, ' ');
  assert.equal(active(input).id, initial);
  act(() => useViewerStore.setState({ cesiumAvailable: true }));
  assert.equal(active(input).id, initial);
});

test('Escape cancels IME composition without dismissing the palette (#8946)', () => {
  let closes = 0;
  const input = mount(() => { closes++; });
  press(input, 'Escape', { isComposing: true });
  press(input, 'Escape', { keyCode: 229 });
  assert.equal(closes, 0);
  press(input, 'Escape');
  assert.equal(closes, 1);
});
