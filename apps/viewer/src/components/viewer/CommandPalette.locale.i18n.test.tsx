/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the command-palette conversion (#4918 slice 3,
 * following slice 2's `shared-commands.locale.i18n.test.tsx`).
 *
 * `CommandPalette.i18n.test.tsx` imports `command-palette.en.ts` directly
 * (to enumerate every static key for its completeness check), so reverting
 * this slice's production files deletes that catalogue and the whole file
 * fails to LOAD — `node --test` never produces a subtest, which the revert
 * oracle correctly reports as an attribution gap, not a red assertion.
 *
 * This file deliberately imports nothing this slice added besides the
 * component itself and the pre-existing `@/i18n` registry, and names
 * catalogue keys as string literals rather than importing them. A revert
 * of the palette conversion still loads this file — it depends on nothing
 * that disappears — and its assertions go red instead, because the
 * reverted `CommandPalette.tsx` prints hardcoded English directly rather
 * than calling `t()`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { cleanup, render, type as typeInto } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { CommandPalette } from './CommandPalette.js';

const mark = (text: string) => `⟦${text}⟧`;

/** A handful of representative keys, named as literals (not imported from
 *  the catalogue module) so this file survives a revert of that module. */
const PSEUDO: Catalogue = {
  'commandPalette.view.home.label': mark('Home'),
  'commandPalette.searchPlaceholder': mark('What do you need?'),
  'commandPalette.footer.navigate': mark('navigate'),
  'commandPalette.category.view': mark('View'),
};

function readableStrings(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
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

// jsdom has no `indexedDB`; the palette's recent-files-cache lookup on open
// catches that and warns rather than throwing, but the warning's captured
// `ReferenceError` text is enough to make an unrelated tool (the revert
// oracle's output classifier) mistake a real assertion failure for a load
// failure. Silenced here rather than in production — the warning is
// accurate and unrelated to this file's own assertions.
const realWarn = console.warn;

beforeEach(() => {
  console.warn = () => {};
  setLocale('en');
  useViewerStore.setState({ cesiumAvailable: true } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  console.warn = realWarn;
  cleanup();
  setLocale('en');
  useViewerStore.setState({ cesiumAvailable: false } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

describe('command palette locale switch (#4918 slice 3)', () => {
  it('re-renders the search placeholder, a command label, a category header, and a footer hint on a live locale switch', () => {
    render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>,
    );

    registerLocale('command-palette-locale-pseudo', PSEUDO);
    act(() => setLocale('command-palette-locale-pseudo'));

    const after = readableStrings();
    assert.ok(after.has(mark('Home')), 'command label "Home" must be translated');
    assert.ok(after.has(mark('What do you need?')), 'search placeholder must be translated');
    assert.ok(after.has(mark('navigate')), 'footer hint must be translated');
    assert.ok(after.has(mark('View')), 'category header must be translated');
  });

  it('filters to the typed query the way it always did (search behaviour is unaffected by translation)', () => {
    render(
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>,
    );
    const input = document.body.querySelector('input') as HTMLInputElement;
    typeInto(input, 'Frame Selection');
    const options = [...document.body.querySelectorAll('[role="option"]')];
    assert.ok(options.some((el) => el.textContent?.includes('Frame Selection')));
  });
});
