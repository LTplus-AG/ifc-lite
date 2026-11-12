/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * While a model loads, both Cancel buttons meet the 24x24 CSS px target
 * minimum (WCAG 2.2 2.5.8) that `target-size-focus-5826.e2e.spec.ts` enforces
 * (#8802). The status bar's Cancel was a 14px uppercase label with `py-0.5`
 * and a border: 20px tall, which that spec caught mid-load. The fix must not
 * grow the 28px status bar.
 *
 * The real StatusBar and ViewportLoadingCard are mounted (happy-dom), then
 * their markup is laid out in real Chrome with the compiled app stylesheet.
 * Only numbers leave the page, never an element.
 */

import '@/test/setup-dom.js';
// StatusBar's FlavorIndicator reads the flavour store from IndexedDB.
import 'fake-indexeddb/auto';
// `__APP_VERSION__` is a vite `define`; StatusBar's footer needs a stand-in.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store/index.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { StatusBar } from './StatusBar.js';
import { ViewportLoadingCard } from './ViewportLoadingCard.js';

const MIN_TARGET_PX = 24;
/** The status bar's own height (`h-7`), which the Cancel must fit inside. */
const STATUS_BAR_PX = 28;

const stubHost = new ExtensionHostService({
  sdk: createBimContext({
    transport: {
      send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
      subscribe: () => () => {},
      close: () => {},
    },
  }),
});

before(warmContrastBrowser);
after(closeContrastBrowser);
afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState({ loading: false, progress: null, geometryProgress: null, activeLoadCanceller: null, loadingFileName: null }));
});

it('the loading Cancel targets are at least 24x24 CSS px and the status bar keeps its height (#8802)', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  act(() => useViewerStore.setState({
    loading: true,
    error: null,
    progress: { phase: 'Loading file', percent: 5 },
    metadataProgress: null,
    geometryProgress: { phase: 'Processing geometry', percent: 42 },
    activeLoadCanceller: () => {},
    loadingFileName: 'AC20-FZK-Haus.ifc',
  }));
  const ui = render(
    <ExtensionHostContext.Provider value={stubHost}>
      <div data-test-viewport style={{ position: 'relative', width: 800, height: 400 }}><ViewportLoadingCard /></div>
      <StatusBar />
    </ExtensionHostContext.Provider>,
  );
  const html = ui.innerHTML;
  cleanup();

  const measured = await withThemedPage('light', `<div style="width:1280px">${html}</div>`, async (page) => {
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return page.evaluate(() => {
      const box = (el: Element | null) => {
        const rect = el?.getBoundingClientRect();
        return rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : { width: 0, height: 0 };
      };
      const card = document.querySelector('[data-viewport-loading-card]');
      const statusCancel = [...document.querySelectorAll('button[title]')]
        .find((button) => !card?.contains(button) && /cancel/i.test(button.textContent ?? '')) ?? null;
      return {
        statusCancel: box(statusCancel),
        statusBar: box(statusCancel?.closest('.h-7') ?? null),
        cardCancel: box(card?.querySelector('button') ?? null),
      };
    });
  });

  for (const [name, size] of [['status bar Cancel', measured.statusCancel], ['loading card Cancel', measured.cardCancel]] as const) {
    assert.ok(size.width >= MIN_TARGET_PX && size.height >= MIN_TARGET_PX,
      `${name} is ${size.width}x${size.height}px, expected at least ${MIN_TARGET_PX}x${MIN_TARGET_PX}`);
  }
  assert.equal(measured.statusBar.height, STATUS_BAR_PX, 'the status bar does not grow');
});
