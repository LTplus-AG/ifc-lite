/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, useState } from 'react';
import { toast, Toaster } from '@/components/ui/toast.js';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { registerLocale, setLocale } from '@/i18n';
import { cleanup, click, render, type as typeInto } from '@/test/render.js';
import { CommandPalette } from './CommandPalette.js';

const pseudo = {
  'commandPalette.category.view': 'Ansichten',
  'commandPalette.noResultsHint': 'Anderes Stichwort versuchen.',
  'commandPalette.clearSearch': 'Suche löschen',
  'viewerShell.dialog.close': 'Schließen',
};
afterEach(() => { cleanup(); setLocale('en'); });

function mount(onOpenChange: (open: boolean) => void = () => {}) {
  setLocale('en');
  render(<BimReactContext.Provider value={{} as BimContext}>
    <CommandPalette open onOpenChange={onOpenChange} />
  </BimReactContext.Provider>);
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  assert.ok(input);
  return input;
}

test('no-results recovery is localized and returns focus and browse options (#8946)', () => {
  const input = mount();
  registerLocale('palette-presentation', pseudo);
  act(() => setLocale('palette-presentation'));
  typeInto(input, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.equal(document.querySelectorAll('[role="option"]').length, 0);
  assert.ok(!document.body.textContent?.includes('navigate'));
  assert.ok(!document.body.textContent?.includes('run'));
  assert.ok(document.body.textContent?.includes('close'));
  assert.ok(document.body.textContent?.includes(pseudo['commandPalette.noResultsHint']));
  const clear = [...document.querySelectorAll('button')].find(button => button.textContent === 'Suche löschen');
  assert.ok(clear);
  assert.equal(clear.closest('[role="listbox"]'), null, 'recovery action is outside the listbox');
  clear.focus();
  click(clear);
  assert.equal(input.value, '');
  assert.equal(document.activeElement, input);
  assert.ok(document.querySelectorAll('[role="option"]').length > 0);
  assert.ok(document.getElementById(input.getAttribute('aria-activedescendant') ?? ''));
});

test('mixed search results show translated categories and explicit close works (#8946)', () => {
  let closed = false;
  const input = mount(open => { closed = !open; });
  typeInto(input, 'home');
  const home = document.querySelector('[data-command-id="view:home"]');
  assert.ok(home);
  assert.ok(home.textContent?.includes('View'));
  registerLocale('palette-presentation', pseudo);
  act(() => setLocale('palette-presentation'));
  assert.ok(home.textContent?.includes('Ansichten'));
  const close = document.querySelector('button[aria-label="Schließen"]');
  assert.ok(close);
  click(close);
  assert.equal(closed, true);
});

test('annot search shows the actual annotation commands without fuzzy noise (#8946)', () => {
  const input = mount();
  typeInto(input, 'annot');
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(row => row.getAttribute('aria-label')),
    ['Annotate', 'Annotations', 'Filter']);
  // Label hits precede the legitimate annotations keyword on class visibility (#8947).
  assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(row => row.getAttribute('data-command-id')),
    ['tool:annotate', 'vis:ifcAnnotations', 'elements:class-filter']);
});

test('closing the palette preserves an existing transient toast (#8946)', () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return <BimReactContext.Provider value={{} as BimContext}>
      <Toaster /><CommandPalette open={open} onOpenChange={setOpen} />
    </BimReactContext.Provider>;
  }
  render(<Harness />);
  let dismiss = () => {};
  act(() => { dismiss = toast.transientError('Palette transient regression', 3000); });
  try {
    const notification = document.querySelector('[data-toast-seq]');
    assert.ok(notification);
    const close = document.querySelector('button[aria-label="Close"]');
    assert.ok(close);
    click(close);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector('[data-toast-seq]'), notification,
      'closing the palette leaves the original toast and its lifecycle intact');
  } finally { act(dismiss); }
});

// Frozen UX query oracle: tests the mounted production command composition,
// including ranking between commands rather than a synthetic ranking fixture.
test('task queries put the intended command first (#8946)', () => {
  const input = mount();
  const oracle = {
    sec: 'tool:section', fit: 'view:fit', hide: 'vis:hide', top: 'view:top',
    wall: 'tool:wall', measure: 'tool:measure', grid: 'vis:ifcGrid', open: 'file:open',
  };
  for (const [query, expected] of Object.entries(oracle)) {
    typeInto(input, query);
    const first = document.querySelector('[role="option"]');
    assert.equal(first?.getAttribute('data-command-id'), expected, query);
    assert.equal(first?.getAttribute('aria-selected'), 'true', query);
  }
});
