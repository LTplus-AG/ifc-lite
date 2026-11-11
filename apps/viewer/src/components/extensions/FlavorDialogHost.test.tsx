/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The profiles (flavors) dialog is a lazy chunk (#9296 eager-JS headroom):
 * a request does not render it synchronously, the first open still shows the
 * real dialog once the chunk resolves, and it stays mounted (closed) after.
 * One test on purpose: React.lazy caches the module for the process, so only
 * the first open can observe the boundary.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { cleanup, render, waitFor } from '@/test/render';
import { FlavorDialogHost } from './FlavorDialogHost';

const sdk = createBimContext({ transport: {
  send: () => Promise.reject(new Error('No SDK transport expected')),
  subscribe: () => () => {}, close: () => {},
} });
let host: ExtensionHostService | undefined;
afterEach(async () => { cleanup(); useViewerStore.setState({ flavorDialogRequested: false }); await host?.dispose(); });

const dialog = () => document.querySelector('[role="dialog"]');

test('the flavors dialog loads on its first request, then closes and reopens in place', async () => {
  setLocale('en');
  host = new ExtensionHostService({ sdk });
  useViewerStore.setState({ flavorDialogRequested: false });
  render(<ExtensionHostContext.Provider value={host}><FlavorDialogHost /></ExtensionHostContext.Provider>);
  assert.equal(dialog(), null, 'closed: nothing is mounted');

  act(() => useViewerStore.getState().setFlavorDialogRequested(true));
  assert.equal(useViewerStore.getState().flavorDialogRequested, false, 'the host consumed the request');
  // A static import renders the dialog inside this act(); the lazy chunk renders it later.
  const syncDialog = dialog() !== null;
  if (syncDialog) cleanup();
  assert.equal(syncDialog, false, 'the dialog is not part of the synchronous open');
  await waitFor(() => dialog() !== null, 'the first request loads and shows the real flavors dialog');

  const close = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Close');
  assert.ok(close, 'the dialog has a Close action');
  act(() => close.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await waitFor(() => dialog() === null, 'the dialog closes');
  act(() => useViewerStore.getState().setFlavorDialogRequested(true));
  await waitFor(() => dialog() !== null, 'a second request shows the dialog again');
});
