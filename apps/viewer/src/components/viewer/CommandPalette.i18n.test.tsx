/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ctrl/Cmd+K command palette reads the i18n catalogue (#4918 slice 3,
 * following slice 1's `MainToolbar.i18n.test.tsx` and slice 2's
 * `shared-commands.i18n.test.tsx`).
 *
 * The oracle is a pseudo-locale that maps every `command-palette.en.ts`
 * static key to a marked copy of its English text. The palette is mounted
 * open, in browse mode (empty query) and once more with a "learn" search;
 * every visible row's text is read off
 * in English, the locale is switched live, and every marked string that
 * was readable in English must reappear marked. A label left hardcoded, or
 * a consumer that does not re-render on a locale switch, fails here by
 * name.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { cleanup, render, type as typeInto } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { commandPaletteEn } from '@/i18n/catalogues/command-palette.en';
import { useViewerStore } from '@/store';
import { CommandPalette } from './CommandPalette.js';

type PaletteKey = keyof typeof commandPaletteEn;
const KEYS = Object.keys(commandPaletteEn) as PaletteKey[];

/**
 * No extension contribution is installed in this render, so its browse
 * header is absent. Its English text collides with the Extensions panel row:
 * a plain
 * `english.has(text)` check cannot tell which key produced it.
 */
const UNREACHABLE_KEYS: PaletteKey[] = ['commandPalette.category.extensions'];
const STATIC_KEYS = KEYS.filter(
  (key) => !(commandPaletteEn[key] as string).includes('{') && !UNREACHABLE_KEYS.includes(key),
);

/** Key-specific pseudo translation. */
const mark = (key: PaletteKey) => `⟦${key}|${commandPaletteEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

function readableStrings(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

const STATE = {
  collabRole: null,
  cesiumAvailable: true,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

const RESET = {
  collabRole: null,
  cesiumAvailable: false,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

/**
 * Keys this render cannot show, each for a stated reason:
 *  - `category.recent` — no recorded command usage in this test's
 *    localStorage, so browse mode never renders a Recent group.
 *  - `panel.collab.label` — gated on `isCollabEnabled()`, off by default
 *    in this test environment (no `VITE_COLLAB`/localStorage override).
 *  - `export.unavailable` — a toast, not palette text; raised only when an
 *    Export row runs with nothing loaded (`commandPaletteExports.test.tsx`).
 *  - `noResults` — neither the browse render nor the "learn" search render
 *    below has zero matches, so the empty-state text never shows; a third
 *    render (a query nothing matches) covers it instead.
 */
const NOT_RENDERED_IN_THIS_STATE: PaletteKey[] = [
  'commandPalette.category.recent',
  'commandPalette.panel.collab.label',
  'commandPalette.export.unavailable',
];

function renderPalette(query: string): HTMLElement {
  const container = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <CommandPalette open onOpenChange={() => {}} />
    </BimReactContext.Provider>,
  );
  if (query) {
    const input = document.body.querySelector('input') as HTMLInputElement;
    typeInto(input, query);
  }
  return container;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(STATE);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('command palette localization (#4918 slice 3)', () => {
  it('translates every static key rendered in browse mode, a Learn search, and a no-match search', () => {
    renderPalette('');
    const browseEnglish = readableStrings();
    cleanup();
    renderPalette('learn');
    const searchEnglish = readableStrings();
    cleanup();
    renderPalette('zzz-no-such-command');
    const emptyEnglish = readableStrings();
    const english = new Set([...browseEnglish, ...searchEnglish, ...emptyEnglish]);

    registerLocale('command-palette-pseudo', PSEUDO);
    act(() => setLocale('command-palette-pseudo'));

    renderPalette('');
    const browseAfter = readableStrings();
    cleanup();
    renderPalette('learn');
    const searchAfter = readableStrings();
    cleanup();
    renderPalette('zzz-no-such-command');
    const emptyAfter = readableStrings();
    const after = new Set([...browseAfter, ...searchAfter, ...emptyAfter]);

    const covered = new Set<PaletteKey>();
    for (const key of STATIC_KEYS) {
      const text = commandPaletteEn[key] as string;
      if (!english.has(text)) continue; // not on screen in either render; checked below
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, or in NOT_RENDERED_IN_THIS_STATE', () => {
    renderPalette('');
    const browseEnglish = readableStrings();
    cleanup();
    renderPalette('learn');
    const searchEnglish = readableStrings();
    cleanup();
    renderPalette('zzz-no-such-command');
    const emptyEnglish = readableStrings();
    const english = new Set([...browseEnglish, ...searchEnglish, ...emptyEnglish]);

    const seen = STATIC_KEYS.filter((key) => english.has(commandPaletteEn[key] as string));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter((key) => seen.includes(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });
});
