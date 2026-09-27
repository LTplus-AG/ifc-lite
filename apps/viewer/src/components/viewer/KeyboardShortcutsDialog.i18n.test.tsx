/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the #4918 slice's `keyboard-shortcuts.en.ts`
 * catalogue and its single consumer, `KeyboardShortcutsDialog.tsx` (the
 * Info dialog: header/footer chrome, tab strip, About/What's New/Shortcuts
 * tabs — Learn is a separate component with its own catalogue, out of
 * scope here). Same pseudo-locale-oracle shape as
 * `WebGpuTroubleshooting.i18n.test.tsx`: every `keyboardShortcuts.*` string
 * is marked, all three in-scope tabs are mounted (each `initialTab` opens
 * its own render, since Radix `Tabs` unmounts inactive panels), the
 * PrivacyBanner disclosure is expanded before the locale switch so its
 * strings are in the DOM to observe, the locale is switched live, and
 * every marked string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
// Vite `define` build-time constants (see vite.config.ts): under plain
// Node they don't exist, so the About/What's New tabs need stand-ins
// before the component renders (same pattern as
// `StatusBar.federation.test.tsx`).
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: Array<{ name: string; version: string }> }).__PACKAGE_VERSIONS__ = [
  { name: '@ifc-lite/viewer', version: '0.0.0-test' },
];
(
  globalThis as unknown as {
    __RELEASE_HISTORY__: Array<{
      name: string;
      releases: Array<{ version: string; highlights: Array<{ type: 'feature' | 'fix' | 'perf'; text: string }> }>;
    }>;
  }
).__RELEASE_HISTORY__ = [
  {
    name: '@ifc-lite/viewer',
    releases: [{ version: '0.0.0-test', highlights: [{ type: 'feature', text: 'Test highlight' }] }],
  },
];

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { keyboardShortcutsEn as KeyboardShortcutsEnType } from '@/i18n/catalogues/keyboard-shortcuts.en';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.js';

// Dynamic + try/catch (not a static import): a revert of this slice's
// production change deletes keyboard-shortcuts.en.ts entirely, and a
// static import would fail the whole test FILE to load
// (ERR_MODULE_NOT_FOUND) rather than let the assertions below fail on
// their own merits — see WebGpuTroubleshooting.i18n.test.tsx for the
// same pattern.
let keyboardShortcutsEnLoaded: typeof KeyboardShortcutsEnType | undefined;
try {
  ({ keyboardShortcutsEn: keyboardShortcutsEnLoaded } = await import('@/i18n/catalogues/keyboard-shortcuts.en'));
} catch {
  keyboardShortcutsEnLoaded = undefined;
}
const keyboardShortcutsEn = keyboardShortcutsEnLoaded ?? ({} as typeof KeyboardShortcutsEnType);

type Key = keyof typeof keyboardShortcutsEn;
const ALL_KEYS = Object.keys(keyboardShortcutsEn) as Key[];

const mark = (key: Key) => `⟦${key}|${String(keyboardShortcutsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('KeyboardShortcutsDialog localization (#4918)', () => {
  it('has no Preferences tab: preferences live in the Settings dialog (#5857)', () => {
    const dialog = render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    const tabs = [...(dialog.ownerDocument.querySelectorAll('[role="tab"]'))].map((tab) => tab.textContent?.trim());
    assert.ok(tabs.includes('About'), `Info dialog renders its tab strip, saw ${JSON.stringify(tabs)}`);
    assert.ok(!tabs.includes('Preferences'), `Info dialog tabs must not include Preferences, saw ${JSON.stringify(tabs)}`);
  });

  it('renders the English catalogue by default across the header, tab strip, footer, and each tab', async () => {
    // The dialog shell is Radix `Dialog` (#5817), which portals its content
    // straight to `document.body` rather than into `render()`'s own
    // container div — so every assertion below reads from the document,
    // not from the (now effectively empty) container each `render()` returns.
    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    const aboutText = () => document.body.textContent ?? '';
    assert.match(aboutText(), /Info/);
    assert.match(aboutText(), /About/);
    assert.match(aboutText(), /What's New/);
    assert.match(aboutText(), /Shortcuts/);
    assert.match(aboutText(), /Learn/);
    assert.match(aboutText(), /Drive from any LLM/);
    assert.match(aboutText(), /to toggle this panel/);
    assert.match(aboutText(), /ifc-lite/);
    assert.match(aboutText(), /v0\.0\.0-test/);
    assert.match(aboutText(), /GitHub/);
    assert.match(aboutText(), /Report issue/);
    assert.match(aboutText(), /MPL-2\.0/);
    assert.match(aboutText(), /1 package/);
    assert.match(aboutText(), /Your IFC data never leaves your device\./);

    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="whatsnew" />);
    await flush();
    assert.match(document.body.textContent ?? '', /You’re on viewer v0\.0\.0-test/);
    assert.match(document.body.textContent ?? '', /rows below are per-package releases/);
    assert.match(document.body.textContent ?? '', /1 change/);
    assert.match(document.body.textContent ?? '', /Feature/);
    assert.match(document.body.textContent ?? '', /Fix/);
    assert.match(document.body.textContent ?? '', /Perf/);

    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="shortcuts" />);
    assert.match(document.body.textContent ?? '', /Learn more:/);
    assert.match(document.body.textContent ?? '', /docs/);
  });

  it('translates every catalogue key rendered across the header/footer, tab strip, and the About/What\'s New/Shortcuts tabs', async () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    // Expand the privacy disclosure BEFORE the locale switch so its strings
    // (intro/wasm link/outro/verify line) are in the DOM to observe. Found
    // document-wide (#5817): the dialog shell is Radix `Dialog`, which
    // portals its content to `document.body` rather than into the
    // container `render()` returns.
    const privacyToggle = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Your IFC data never leaves your device.'),
    );
    assert.ok(privacyToggle, 'expected the privacy disclosure toggle');
    act(() => privacyToggle.click());

    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="whatsnew" />);
    await flush();
    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="shortcuts" />);

    // All three dialogs stay mounted (this test never closes one before
    // opening the next) and all three portal into the same `document.body`,
    // so one read after all three renders covers every tab.
    const english = document.body.textContent ?? '';

    registerLocale('keyboard-shortcuts-pseudo', PSEUDO);
    act(() => setLocale('keyboard-shortcuts-pseudo'));
    const after = document.body.textContent ?? '';

    for (const key of ALL_KEYS) {
      const text = String(keyboardShortcutsEn[key]);
      if (!english.includes(text)) continue; // key not exercised by this render set (e.g. plural "other" form)
      assert.ok(after.includes(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });

  it('lets a registered locale translate a key and falls back to English for one it omits', () => {
    registerLocale('keyboard-shortcuts-partial', {
      'keyboardShortcuts.header.title': 'INFO (fr)',
    } as Catalogue);
    setLocale('keyboard-shortcuts-partial');
    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    assert.match(document.body.textContent ?? '', /INFO \(fr\)/);
    // 'keyboardShortcuts.tabs.about' was not overridden: still English.
    assert.match(document.body.textContent ?? '', /About/);
  });
});
