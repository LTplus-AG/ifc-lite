/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState, type ReactNode } from 'react';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { advance, click, render, type as enterText } from '@/test/render';
import { CommandPalette } from '@/components/viewer/CommandPalette';
import { PersistentToolHosts } from '@/components/viewer/PersistentToolHosts';

/** Real host and SDK; no transport operation is needed to open local destinations. */
export function mountDestinations(children: ReactNode) {
  const bim = createBimContext({ transport: {
    send: () => Promise.reject(new Error('No remote transport in local destination tests')),
    subscribe: () => () => {}, close: () => {},
  } });
  const host = new ExtensionHostService({ sdk: bim });
  function Harness() {
    const [open, setOpen] = useState(false);
    return <BimReactContext.Provider value={bim}><ExtensionHostContext.Provider value={host}>
      <PersistentToolHosts>
        <button data-palette-launcher onClick={() => setOpen(true)}>Commands</button>
        <CommandPalette open={open} onOpenChange={setOpen} />
        {children}
      </PersistentToolHosts>
    </ExtensionHostContext.Provider></BimReactContext.Provider>;
  }
  render(<Harness />);
  return host;
}
export function destinationOption(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(row, id);
  return row;
}
export function searchDestination(query: string) {
  const launcher = document.querySelector('[data-palette-launcher]');
  assert.ok(launcher); click(launcher);
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(input); enterText(input, query);
  return input;
}
export async function launchDestination(id: string, query: string) {
  const settings = document.querySelector('[data-settings-dialog]');
  if (settings) click(namedButton('Close', settings));
  searchDestination(query);
  click(destinationOption(id));
  await advance(60);
}
export function namedButton(label: string, root: ParentNode = document): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  assert.ok(button, label); return button;
}
