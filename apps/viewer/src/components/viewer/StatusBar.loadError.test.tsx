/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 review (SHOULD-FIX #3) — the status bar used to render the store's
 * `error` as its own span, so a load failure showed twice: once here, once
 * in the in-viewport `ViewportLoadErrorCard`. It renders no error text of
 * its own any more; while not loading and not in error it falls back to
 * the plain "Ready" label.
 */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { render, cleanup } from '@/test/render.js';
import { StatusBar } from './StatusBar.js';

const stubHost = new ExtensionHostService({
  sdk: createBimContext({
    transport: {
      send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
      subscribe: () => () => {},
      close: () => {},
    },
  }),
});

beforeEach(() => {
  act(() => useViewerStore.setState({ loading: false, error: null }));
});

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ loading: false, error: null }));
});

function renderStatusBar(): HTMLElement {
  return render(
    <ExtensionHostContext.Provider value={stubHost}>
      <StatusBar />
    </ExtensionHostContext.Provider>,
  );
}

describe('StatusBar load error (#5851)', () => {
  it('does not render the store error text', () => {
    const longMessage = 'Could not download the linked model — the failure the viewport card owns now';
    act(() => useViewerStore.setState({ error: longMessage }));
    const container = renderStatusBar();
    assert.equal(container.textContent?.includes(longMessage), false, 'the status bar must not render the load error itself');
  });

  it('falls back to Ready while not loading, even with an error set', () => {
    act(() => useViewerStore.setState({ error: 'boom' }));
    const container = renderStatusBar();
    assert.ok(container.textContent?.includes('Ready'), 'no error text of its own to show, so it reads Ready');
  });
});
