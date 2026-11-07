/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Command Palette's `export:anonymized` entry (#2934): opens the anonymized
 * export dialog and closes the palette. Since #5601 the palette's Export rows
 * come from the toolbar registry and open its dialogs through their own
 * trigger (`useExportRunner.tsx`), so the row no longer sets
 * `anonymizedExportRequested`; that flag is the entity context menu's.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect, useState } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import { resolveEnglish } from '@/i18n/registry';
import { EVENT_OPEN_COMMAND_PALETTE, emitOpenCommandPalette } from '@/lib/tours/events';
import { advance, cleanup, click, render, type as typeInto, waitFor, press } from '@/test/render.js';
import { CommandPaletteHost } from './CommandPaletteHost.js';

function PaletteLauncher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const launch = () => setOpen(true);
    window.addEventListener(EVENT_OPEN_COMMAND_PALETTE, launch);
    return () => window.removeEventListener(EVENT_OPEN_COMMAND_PALETTE, launch);
  }, []);
  return (
    <BimReactContext.Provider value={{} as BimContext}>
      <button type="button" aria-expanded={open} onClick={emitOpenCommandPalette}>
        {resolveEnglish('commandPalette.ariaLabel')}
      </button>
      <CommandPaletteHost open={open} onOpenChange={setOpen} />
    </BimReactContext.Provider>
  );
}
after(cleanup);

beforeEach(() => {
  cleanup();
  // The registry gates this format on a loaded model (`requires: 'model'`).
  useViewerStore.setState({
    anonymizedExportRequested: false,
    ifcDataStore: { source: { byteLength: 4 } } as unknown as IfcDataStore,
  });
});
after(() => { useViewerStore.setState({ ifcDataStore: null }); });

describe('CommandPalette — export:anonymized', () => {
  it('running the command retains the export dialog after the lazy palette closes (#8947)', async () => {
    const container = render(<PaletteLauncher />);
    const launcher = container.querySelector('button');
    assert.ok(launcher);
    assert.equal(launcher.getAttribute('aria-expanded'), 'false');
    assert.equal(document.body.querySelector('[role="combobox"]'), null);
    launcher.focus();
    click(launcher);
    await waitFor(() => document.body.querySelector('[role="combobox"]') !== null,
      'the lazy palette must open from its launcher');

    // Radix portals the dialog content onto `document.body`, not the
    // container it was rendered into (`apps/viewer/AGENTS.md` viewer-test
    // recipe).
    const input = document.body.querySelector<HTMLInputElement>('[role="combobox"]');
    assert.ok(input, 'no search input');
    assert.equal(launcher.getAttribute('aria-expanded'), 'true');
    press(input, 'Escape');
    await waitFor(() => document.activeElement === launcher,
      'first-load handoff must restore the original launcher, not the removed loading button');
    click(launcher);
    await waitFor(() => document.body.querySelector('[role="combobox"]') !== null,
      'the retained palette must reopen');
    const reopened = document.body.querySelector<HTMLInputElement>('[role="combobox"]');
    assert.ok(reopened);
    typeInto(reopened, 'Export anonymized');

    const option = [...document.body.querySelectorAll('[role="option"]')].find(
      (el) => /^Export anonymized subset/i.test(el.textContent ?? ''),
    );
    assert.ok(option, `no palette entry for anonymized export; saw ${
      [...document.body.querySelectorAll('[role="option"]')].map((el) => el.textContent).join(' | ')
    }`);

    act(() => {
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const title = resolveEnglish('anonymizedExport.dialog.title');
    await waitFor(() => [...document.body.querySelectorAll('[role="dialog"]')]
      .some((d) => d.textContent?.includes(title)), 'the anonymized export dialog must open');
    await advance(20);
    assert.ok(
      [...document.body.querySelectorAll('[role="dialog"]')].some((d) => d.textContent?.includes(title)),
      'the anonymized export dialog must stay mounted after the palette closes',
    );
    assert.equal(launcher.getAttribute('aria-expanded'), 'false', 'the palette state must close');
    assert.equal(document.body.querySelector('[role="combobox"]'), null, 'the palette must leave the DOM');
  });
});
