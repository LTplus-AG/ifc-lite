/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render, type as typeInto, advance, waitFor, press } from '@/test/render.js';
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { CommandPalette } from './CommandPalette.js';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';

beforeEach(() => {
  setLocale('en');
  localStorage.clear();
  useViewerStore.setState({
    isMobile: false, models: new Map(),
    sidebarActivePanel: 'properties', scriptPanelVisible: false, chatPanelVisible: false,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  useViewerStore.setState({
    sidebarActivePanel: 'properties', scriptPanelVisible: false, chatPanelVisible: false,
  });
});

test('the visible ribbon Commands button opens the palette (#5862)', async () => {
  const layout = renderViewerLayout();
  const button = [...layout.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes('Commands…'));
  assert.ok(button, 'the ribbon exposes the Commands button');
  click(button);
  const pending = document.body.querySelector('[role="dialog"]');
  assert.ok(pending?.querySelector('output'), 'first open exposes the cancellable loading shell');
  press(pending, 'Escape');
  await advance(20);
  assert.equal(document.body.querySelector('[role="dialog"]'), null,
    'Escape cancels the pending open; a late chunk must not reopen it (#8947)');
  click(button);
  await waitFor(() => document.body.querySelector('[role="dialog"][aria-label="Command palette"]') !== null,
    'the first Commands activation must load and open the palette');
  await waitFor(() => document.activeElement?.getAttribute('role') === 'combobox',
    'the lazily mounted search input must receive keyboard focus');
});

test('Cost and AI Chat palette rows open their panels (#5862)', async () => {
  render(
    <BimReactContext.Provider value={{} as BimContext}>
      <CommandPalette open onOpenChange={() => {}} />
    </BimReactContext.Provider>,
  );
  const input = document.body.querySelector('input') as HTMLInputElement;
  typeInto(input, 'cost');
  const cost = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((row) => row.getAttribute('aria-label') === 'Cost');
  assert.ok(cost, 'Cost is searchable');
  click(cost);
  await advance(50);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'cost');

  cleanup();
  render(
    <BimReactContext.Provider value={{} as BimContext}>
      <CommandPalette open onOpenChange={() => {}} />
    </BimReactContext.Provider>,
  );
  typeInto(document.body.querySelector('input') as HTMLInputElement, 'chat');
  const chat = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((row) => row.getAttribute('aria-label') === 'AI Chat');
  assert.ok(chat, 'AI Chat is searchable');
  click(chat);
  await advance(50);
  const state = useViewerStore.getState();
  assert.equal(state.scriptPanelVisible, true);
  assert.equal(state.chatPanelVisible, true);
});
