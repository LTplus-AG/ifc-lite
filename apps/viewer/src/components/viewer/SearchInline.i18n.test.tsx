/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchInline`'s own chrome reads the i18n catalogue (#4918 search-modal
 * slice, `search-modal.en.ts`'s `searchModal.inline.*` keys): the field's
 * own placeholder/aria-label, the advanced-filter affordance, and the
 * empty-query popover's hint states (no active query, so no result rows or
 * recents are seeded — this exercises the "no results" branch, not the
 * results-list rows).
 *
 * The oracle is a pseudo-locale that marks every `searchModal.inline.*` key
 * with a `⟦…⟧` wrapper; the real English text (computed through `resolve()`,
 * never hardcoded here) must be on screen before the switch, and the marked
 * form must reappear after it.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { SearchInline } from './SearchInline.js';
import { shortcutLabel } from '@/lib/commands/shortcut-label';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('searchModal.inline.')),
);
const KEYS = Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(CATALOGUE[key]!)]));
const BASELINE_LOCALE = 'en';
const PSEUDO_LOCALE = 'search-inline-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: ParentNode): Set<string> {
  act(() => setLocale(PSEUDO_LOCALE));
  const set = readableStrings(container);
  act(() => setLocale(BASELINE_LOCALE));
  return set;
}

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ models: new Map(), activeModelId: null, searchQuery: '', searchOpen: false });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

describe('SearchInline localization (#4918)', () => {
  it('translates the field itself (placeholder, aria-label)', () => {
    const container = render(<SearchInline />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [{ key: 'searchModal.inline.searchPlaceholder' }, { key: 'searchModal.inline.searchAriaLabel' }],
      englishDom,
      afterDom,
    );
  });

  it('translates the advanced-filter affordance and the empty-popover no-results hint', () => {
    const container = render(<SearchInline />);
    act(() => {
      useViewerStore.setState({ searchQuery: 'zz-no-match', searchOpen: true });
    });
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [{ key: 'searchModal.inline.advancedFilter' }, { key: 'searchModal.inline.advancedFilterTitle', params: { keys: shortcutLabel('search.openAdvanced') } }, { key: 'searchModal.inline.noResultsHint' }],
      englishDom,
      afterDom,
    );
  });
});
