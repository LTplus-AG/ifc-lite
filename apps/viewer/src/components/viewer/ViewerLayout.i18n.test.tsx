/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ViewerLayout`'s own top-level chrome reads the i18n catalogue (#4918
 * slice: shell/sidebar chrome, `shell-chrome.en.ts`'s `shellChrome.layout.*`
 * keys): the safe-mode banner (`styleInterpolatedValues` around a plain
 * `{flag}` param) and the mobile floating Hierarchy/Properties buttons.
 *
 * Same pseudo-locale oracle shape as `viewer-shell.i18n.test.tsx`: mark
 * every English string, switch locale live, assert the marked form
 * reappears. `isSafeMode()` reads `window.location.search`, so the safe-mode
 * banner pass reconfigures the jsdom URL before rendering; the mobile pass
 * flips `isMobile` in the store instead, since that path does not depend on
 * the real `useKeyboardShortcuts`/`useIfc` wiring to show its own chrome.
 */
import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { shellChromeEn as ShellChromeEnType } from '@/i18n/catalogues/shell-chrome.en';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';

// Guarded dynamic import (#4918 revert-oracle): a plain static import would
// fail the whole FILE's load if this catalogue is reverted/deleted (zero
// subtests collected -> INCONCLUSIVE); this turns that into an empty
// catalogue instead, so every assertion below runs for real and fails on
// its own merits when the production wiring is gone.
let shellChromeEnLoaded: typeof ShellChromeEnType | undefined;
try {
  ({ shellChromeEn: shellChromeEnLoaded } = await import('@/i18n/catalogues/shell-chrome.en'));
} catch {
  shellChromeEnLoaded = undefined;
}
const shellChromeEn: typeof ShellChromeEnType = shellChromeEnLoaded ?? ({} as typeof ShellChromeEnType);

/** The mobile floating Hierarchy/Properties buttons only render once a model
 *  is loaded (`hasModelsLoaded`); this is the same minimal fixture
 *  `MainToolbar.i18n.test.tsx`'s `makeModel()` uses. */
function makeModel(): FederatedModel {
  return {
    id: 'm1',
    name: 'm1.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    idOffset: 0,
    maxExpressId: 0,
  };
}

type ShellChromeKey = keyof typeof ShellChromeEnType;
const mark = (key: ShellChromeKey) => {
  const value = shellChromeEn[key];
  if (typeof value !== 'string') throw new Error(`${key} is not a plain string value`);
  return `⟦${key}|${value}⟧`;
};
const LAYOUT_KEYS = (Object.keys(shellChromeEn) as ShellChromeKey[]).filter((key) =>
  key.startsWith('shellChrome.layout.'),
);
const PSEUDO: Catalogue = Object.fromEntries(LAYOUT_KEYS.map((key) => [key, mark(key)]));

function bodyText(): string {
  return document.body.textContent ?? '';
}

function setSearch(search: string): void {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(null, '', url.toString());
}

const RESET = {
  isMobile: false,
  leftPanelCollapsed: true,
  rightPanelCollapsed: true,
  models: new Map<string, FederatedModel>(),
};

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  setSearch('');
  useViewerStore.setState(RESET);
});

describe('ViewerLayout localization (#4918)', () => {
  it('translates the safe-mode banner', () => {
    setSearch('?safe=1');
    renderViewerLayout();
    const english = bodyText();
    assert.ok(
      english.includes('Safe mode: extensions and the active profile are not loaded for this session.'),
      'expected the safe-mode banner in English',
    );
    assert.ok(english.includes('?safe=0'));

    registerLocale('viewer-layout-safe-mode-pseudo', PSEUDO);
    act(() => setLocale('viewer-layout-safe-mode-pseudo'));
    const after = bodyText();
    assert.ok(
      after.includes(mark('shellChrome.layout.safeModeNotice' as ShellChromeKey).replace('{flag}', '?safe=0')),
      'expected the marked+interpolated safe-mode banner',
    );
  });

  it('translates the mobile floating Hierarchy/Properties buttons', () => {
    // ViewerLayout's own "Detect mobile viewport" effect recomputes
    // `isMobile` from `window.innerWidth`/touch capability on mount and would
    // otherwise overwrite a forced `isMobile: true` store value right back to
    // `false` — narrow the jsdom viewport instead of fighting the effect.
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    useViewerStore.setState({
      leftPanelCollapsed: true,
      rightPanelCollapsed: true,
      models: new Map([['m1', makeModel()]]),
    });
    const container = renderViewerLayout();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    const hierarchyBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Open Hierarchy',
    );
    const propertiesBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Open Properties',
    );
    assert.ok(hierarchyBtn, 'expected the mobile "Open Hierarchy" button');
    assert.ok(propertiesBtn, 'expected the mobile "Open Properties" button');

    registerLocale('viewer-layout-mobile-pseudo', PSEUDO);
    act(() => setLocale('viewer-layout-mobile-pseudo'));

    assert.equal(hierarchyBtn!.getAttribute('aria-label'), mark('shellChrome.layout.openHierarchyAriaLabel' as ShellChromeKey));
    assert.equal(propertiesBtn!.getAttribute('aria-label'), mark('shellChrome.layout.openPropertiesAriaLabel' as ShellChromeKey));
    assert.ok(bodyText().includes(mark('shellChrome.layout.hierarchyLabel' as ShellChromeKey)));
    assert.ok(bodyText().includes(mark('shellChrome.layout.propertiesLabel' as ShellChromeKey)));
  });
});
