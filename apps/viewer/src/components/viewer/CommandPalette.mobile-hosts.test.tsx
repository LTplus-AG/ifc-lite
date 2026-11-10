/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { IdbFlavorStorage } from '@/services/extensions/idb-flavor-storage';
import { FlavorDialogHost } from '@/components/extensions/FlavorDialogHost';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { advance, cleanup, click, press, render, type as typeInto } from '@/test/render';
import { CommandPalette } from './CommandPalette';
import { MobileToolbar } from './MobileToolbar';
import { getMountedFileHost } from './toolbar/mounted-file-host';
import { FILE_ACCEPT } from '@/services/supported-model-files';

const originalState = useViewerStore.getState();
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalPicker = Object.getOwnPropertyDescriptor(window, 'showOpenFilePicker');
const sdk = createBimContext({ transport: {
  send: () => Promise.reject(new Error('No SDK transport expected in host destination tests')),
  subscribe: () => () => {}, close: () => {},
} });
let host: ExtensionHostService;
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  await new IdbFlavorStorage().clear();
  host = new ExtensionHostService({ sdk });
  useViewerStore.setState({ ...fixtureModels(fixtureModel('a')), loading: false, flavorDialogRequested: false });
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});
afterEach(async () => {
  cleanup(); mock.restoreAll(); await host.dispose();
  useViewerStore.setState(originalState); localStorage.clear();
  for (const [object, key, descriptor] of [[navigator, 'gpu', originalGpu], [window, 'showOpenFilePicker', originalPicker]] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
});
function Harness() {
  const [open, setOpen] = useState(true);
  return <BimReactContext.Provider value={sdk}><ExtensionHostContext.Provider value={host}>
    <MobileToolbar />
    <FlavorDialogHost />
    <button onClick={() => setOpen(true)}>Reopen palette</button>
    <CommandPalette open={open} onOpenChange={setOpen} />
  </ExtensionHostContext.Provider></BimReactContext.Provider>;
}
function option(id: string) {
  const found = document.querySelector<HTMLButtonElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(found, id); return found;
}
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(found, text); return found;
}

test('#8947 mobile palette Open and Add reach the single canonical inputs in the trusted activation stack', async () => {
  render(<Harness />); await advance(30);
  const inputs = [...document.querySelectorAll<HTMLInputElement>('#file-input-open, #file-input-add')];
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(input => input.accept === FILE_ACCEPT), 'mobile exposes the canonical supported formats');
  const picks: string[] = [];
  mock.method(HTMLInputElement.prototype, 'click', function (this: HTMLInputElement) { picks.push(this.id); });
  const search = document.querySelector<HTMLInputElement>('input[role="combobox"]'); assert.ok(search);
  typeInto(search, 'open file');
  act(() => option('file:open').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  press(search, 'Enter');
  assert.deepEqual(picks, ['file-input-open'], 'no deferred frame before opening the picker');
  click(button('Reopen palette')); await advance(10);
  click(option('file:add-model'));
  assert.deepEqual(picks, ['file-input-open', 'file-input-add']);
  act(() => window.dispatchEvent(new CustomEvent('ifc-lite:open-files')));
  assert.deepEqual(picks, ['file-input-open', 'file-input-add', 'file-input-open'], 'global event has exactly one mobile receiver');
  assert.ok(getMountedFileHost()); cleanup(); assert.equal(getMountedFileHost(), null);
});

test('#8947 Manage flavors reaches its real stored-flavor flow without mounting a desktop status bar', async () => {
  await host.flavors.put({ schemaVersion: 1, id: 'palette-mobile', name: 'Mobile review setup', description: '',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    extensions: [], lenses: [], savedQueries: [], keybindings: [], layout: { state: {} }, settings: {} });
  render(<Harness />); await advance(30);
  click(option('extensions:flavors')); await advance(100);
  assert.equal(useViewerStore.getState().flavorDialogRequested, false, 'the persistent host consumed the request');
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Mobile review setup/);
  assert.ok(button('Activate'), 'the real flavor action is reachable');
  press(dialog, 'Escape'); await advance(10);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  click(button('Reopen palette')); await advance(10);
  click(option('extensions:flavors')); await advance(100);
  assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Mobile review setup/);
});
