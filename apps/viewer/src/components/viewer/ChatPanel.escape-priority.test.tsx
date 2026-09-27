/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useViewerStore } from '@/store';
import { cleanup, press, render } from '@/test/render.js';
import { ChatPanel } from './ChatPanel.js';

const originalFetch = globalThis.fetch;
let initialState: ReturnType<typeof useViewerStore.getState>;

function mountChat(onClose: () => void): HTMLElement {
  return render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={{} as ExtensionHostService}>
        <ChatPanel onClose={onClose} />
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
}

before(() => { initialState = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useViewerStore.setState(initialState, true);
});

it('Escape in Chat closes Chat before an active tool and retains selection (#5841)', () => {
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  useViewerStore.setState({ selectedEntityId: 42, selectedEntityIds: new Set([42]) });
  let toolCancels = 0;
  let chatCloses = 0;
  const removeTool = registerKeyboardCommand('measure.cancel', () => { toolCancels++; });
  try {
    const panel = mountChat(() => { chatCloses++; });
    const input = panel.querySelector('textarea');
    assert.ok(input);
    assert.equal(input.disabled, false);
    act(() => input.focus());
    press(input, 'Escape');
    assert.equal(chatCloses, 1, 'focused Chat owns its Escape');
    assert.equal(toolCancels, 0, 'the measurement remains active');
    assert.equal(useViewerStore.getState().selectedEntityId, 42);
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [42]);
    const button = panel.querySelector<HTMLButtonElement>('button[aria-label="Close AI chat"]');
    assert.ok(button);
    button.focus();
    assert.equal(document.activeElement, button);
    press(button, 'Escape');
    assert.equal(chatCloses, 2, 'focused Chat control owns its Escape');
    assert.equal(toolCancels, 0, 'the measurement remains active');
    assert.equal(useViewerStore.getState().selectedEntityId, 42);
  } finally {
    removeTool();
  }
});
