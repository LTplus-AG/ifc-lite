/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `StatusBar`'s own chrome reads the i18n catalogue (#4918 slice: shell/
 * sidebar chrome, `shell-chrome.en.ts`'s `shellChrome.statusBar.*` keys).
 *
 * Same pseudo-locale oracle shape as `MainToolbar.i18n.test.tsx`: every
 * static key is marked `⟦key|…⟧`, the bar is rendered with no model loaded
 * and diagnostics enabled (the "Ready" / empty-count / WebGPU-status branch),
 * the locale is switched live, and every marked string readable in English
 * must reappear marked. The count-driven `elementsCount` / `trisCount`
 * plural keys and the `appVersion` / `ifcliteLinkLabel` keys are checked by
 * exact expected text since they carry a `{param}` this render's own values
 * determine (0 elements/tris, the build's `__APP_VERSION__`).
 */
import '@/test/setup-dom.js';
// `__APP_VERSION__` is a vite `define` (see vite.config.ts) baked in at build
// time; under plain Node it doesn't exist, so StatusBar's footer version
// string needs a stand-in before it renders.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { shellChromeEn as ShellChromeEnType } from '@/i18n/catalogues/shell-chrome.en';
import type { PluralTranslation, TranslationValue } from '@/i18n/types';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { StatusBar } from './StatusBar.js';
import { useViewerStore } from '@/store';

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

/** `StatusBar` always mounts `FlavorDialog`, which calls `useExtensionHost()`
 *  unconditionally regardless of its own `open` prop — same stub-host seam
 *  `FlavorDialog.unapplied-toast.test.tsx` uses instead of `mock.module`. */
class StubExtensionHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

type ShellChromeKey = keyof typeof ShellChromeEnType;
const STATUS_BAR_KEYS = (Object.keys(shellChromeEn) as ShellChromeKey[]).filter((key) =>
  key.startsWith('shellChrome.statusBar.'),
);
const STATIC_KEYS = STATUS_BAR_KEYS.filter((key) => {
  const value = shellChromeEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ShellChromeKey) => {
  const value = shellChromeEn[key];
  if (typeof value !== 'string') throw new Error(`${key} is a plural value; use markedPlural instead`);
  return `⟦${key}|${value}⟧`;
};

/** Marks every category of a plural value independently, so a registered
 *  pseudo-locale still resolves through `registry.ts`'s real plural-category
 *  selection instead of collapsing to one static string. */
function markValue(key: ShellChromeKey, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${key}|${text}⟧`;
  }
  return marked as PluralTranslation;
}
const PSEUDO: Catalogue = Object.fromEntries(
  STATUS_BAR_KEYS.map((key) => [key, markValue(key, shellChromeEn[key])]),
);

/** Exact per-element own-text/aria-label strings, not a whole-body substring
 *  search — "No WebGPU" contains "WebGPU", so a substring check on the raw
 *  body text would false-positive-match `webgpuLabel` even when the DOM
 *  actually shows the "no support" branch. */
function readableStrings(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

/** Values `t()` picks with `count: 0` — English's `Intl.PluralRules` selects
 *  the "other" category for zero. */
function markedPlural(key: ShellChromeKey): string {
  const value = shellChromeEn[key];
  if (typeof value === 'string') throw new Error(`${key} is not a plural value`);
  return `⟦${key}|${value.other}⟧`;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({ showPerformanceStats: true });
});
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ showPerformanceStats: false });
});

describe('StatusBar localization (#4918)', () => {
  it('translates the always-visible status chrome', async () => {
    render(
      <ExtensionHostContext.Provider value={new StubExtensionHost()}>
        <StatusBar />
      </ExtensionHostContext.Provider>,
    );
    // Let the async WebGPU probe (`useWebGPU`) settle past its initial
    // "Checking..." state before reading the DOM.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const english = readableStrings();

    registerLocale('status-bar-pseudo', PSEUDO);
    act(() => setLocale('status-bar-pseudo'));
    const after = readableStrings();

    // The three WebGPU-status keys share a render-state branch (only one is
    // ever on screen); a whole-body substring search would also false-match
    // "No WebGPU" against the `webgpuLabel` value it contains, so those three
    // are checked explicitly below instead of through this generic sweep.
    const WEBGPU_KEYS = new Set<ShellChromeKey>([
      'shellChrome.statusBar.webgpuChecking',
      'shellChrome.statusBar.webgpuLabel',
      'shellChrome.statusBar.noWebgpuLabel',
    ]);
    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      if (WEBGPU_KEYS.has(key)) continue;
      const text = shellChromeEn[key];
      if (typeof text !== 'string' || !english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'expected at least one static statusBar key to be visible in the default render');

    const renderedWebgpuKey = [...WEBGPU_KEYS].find((key) => english.has(shellChromeEn[key] as string));
    assert.ok(renderedWebgpuKey, 'expected exactly one WebGPU-status string on screen');
    assert.ok(
      after.has(mark(renderedWebgpuKey!)),
      `${renderedWebgpuKey}: WebGPU status text must be translated`,
    );

    // No model loaded: visibleElements/triangleCount are both 0. The count and
    // the translated word are separate JSX children of the same <span>
    // ("0" + " " + "elements"), so `readableStrings()` groups them into one
    // combined own-text entry — a substring check for the marked plural
    // value is the right granularity here, not an exact match.
    assert.ok(english.has('Ready'));
    assert.ok(after.has(mark('shellChrome.statusBar.ready' as ShellChromeKey)));
    assert.ok([...english].some((s) => s.includes('0') && s.includes('elements')));
    assert.ok(
      [...after].some((s) => s.includes(markedPlural('shellChrome.statusBar.elementsCount' as ShellChromeKey))),
    );
    assert.ok([...english].some((s) => s.includes('0') && s.includes('tris')));
    assert.ok(
      [...after].some((s) => s.includes(markedPlural('shellChrome.statusBar.trisCount' as ShellChromeKey))),
    );

    // v{version} / ifclite.dev link are always shown, independent of model state.
    assert.ok(english.has('v0.0.0-test'));
    assert.ok(
      after.has(mark('shellChrome.statusBar.appVersion' as ShellChromeKey).replace('{version}', '0.0.0-test')),
    );
    assert.ok(after.has(mark('shellChrome.statusBar.ifcliteLinkLabel' as ShellChromeKey)));
    const ifcliteLink = document.querySelector('a[href="https://ifclite.dev"]');
    assert.ok(ifcliteLink, 'expected the ifclite.dev link');
    assert.equal(
      ifcliteLink!.getAttribute('aria-label'),
      mark('shellChrome.statusBar.ifcliteAriaLabel' as ShellChromeKey),
    );
  });
});
