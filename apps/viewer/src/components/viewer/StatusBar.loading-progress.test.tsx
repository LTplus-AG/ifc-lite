/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5849 — the status bar's loading phase reads the same
 * `selectActiveLoadProgress` as the toolbars and the in-viewport loading
 * card, so once geometry streaming starts it shows that phase rather than
 * the stale generic `progress` phase.
 */

import '@/test/setup-dom.js';
// StatusBar's FlavorIndicator reads the flavour store from IndexedDB.
import 'fake-indexeddb/auto';
// `__APP_VERSION__` is a vite `define`; StatusBar's footer needs a stand-in.
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
  act(() => useViewerStore.setState({
    loading: true,
    error: null,
    progress: { phase: 'Loading file', percent: 5 },
    metadataProgress: null,
    geometryProgress: { phase: 'Processing geometry', percent: 42 },
  }));
});

afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ loading: false, progress: null, metadataProgress: null, geometryProgress: null }));
});

describe('status bar loading phase (#5849)', () => {
  it('shows the same active phase as the toolbars and the loading card', () => {
    const container = render(
      <ExtensionHostContext.Provider value={stubHost}>
        <StatusBar />
      </ExtensionHostContext.Provider>,
    );
    const text = container.textContent ?? '';
    assert.ok(text.includes('Processing geometry'), `geometry progress wins over the generic phase: ${text}`);
    assert.ok(!text.includes('Loading file'), `the stale generic phase is not shown: ${text}`);
  });
});
