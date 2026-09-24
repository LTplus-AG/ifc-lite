/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Command Palette's `export:anonymized` entry (#2934): opens the anonymized
 * export dialog and closes the palette. Since #5601 the palette's Export rows
 * come from the toolbar registry and open its dialogs through their own
 * trigger (`usePaletteExportRunner.tsx`), so the row no longer sets
 * `anonymizedExportRequested`; that flag is the entity context menu's.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import { resolveEnglish } from '@/i18n/registry';
import { CommandPalette } from './CommandPalette.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(open: boolean, onOpenChange: (open: boolean) => void): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open={open} onOpenChange={onOpenChange} />
      </BimReactContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

beforeEach(() => {
  unmountAll();
  // The registry gates this format on a loaded model (`requires: 'model'`).
  useViewerStore.setState({
    anonymizedExportRequested: false,
    ifcDataStore: { source: { byteLength: 4 } } as unknown as IfcDataStore,
  });
});
after(() => { useViewerStore.setState({ ifcDataStore: null }); });

/** Flush the `requestAnimationFrame` `runCommand` defers a non-`immediate`
 *  command's action to. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('CommandPalette — export:anonymized', () => {
  it('running the command opens the anonymized export dialog and closes the palette', async () => {
    let open = true;
    const onOpenChange = (next: boolean) => { open = next; };
    render(open, onOpenChange);

    // Radix portals the dialog content onto `document.body`, not the
    // container it was rendered into (`apps/viewer/AGENTS.md` viewer-test
    // recipe).
    const input = document.body.querySelector('input') as HTMLInputElement;
    assert.ok(input, 'no search input');
    act(() => {
      input.value = 'Export anonymized';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    const option = [...document.body.querySelectorAll('[role="option"]')].find(
      (el) => /^Export anonymized subset/i.test(el.textContent ?? ''),
    );
    assert.ok(option, `no palette entry for anonymized export; saw ${
      [...document.body.querySelectorAll('[role="option"]')].map((el) => el.textContent).join(' | ')
    }`);

    act(() => {
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await advance(10);

    const title = resolveEnglish('anonymizedExport.dialog.title');
    assert.ok(
      [...document.body.querySelectorAll('[role="dialog"]')].some((d) => d.textContent?.includes(title)),
      'the anonymized export dialog must open',
    );
    assert.equal(open, false, 'the palette must close after running a command');
  });
});
