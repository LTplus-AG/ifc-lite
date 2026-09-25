/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PresentationPanel`'s own i18n coverage, split out of
 * `MiscPanelsA.i18n.test.tsx` when the `presentation` bottom panel replaced
 * `BasketPresentationDock`'s floating card (#5508) — its `basketPresentationDock.*`
 * prefix is `presentationPanel.*` here, in `misc-panels-a.en.ts` (still the
 * catalogue home; only the component moved).
 *
 * Same pseudo-locale-oracle shape as the file it came from: every catalogue
 * key under the prefix is marked, the panel is rendered in each branch that
 * surfaces distinct copy, the locale is switched live, and every marked
 * string that was readable in English must reappear marked.
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
import { PresentationPanel } from './PresentationPanel.js';
import type { BasketView } from '@/store/slices/pinboardSlice';

const PREFIX = 'presentationPanel.';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith(PREFIX)),
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
const PSEUDO_LOCALE = 'presentation-panel-pseudo';

interface DomSnapshot {
  text: string;
  attrs: Set<string>;
}

function snapshotDom(container: HTMLElement): DomSnapshot {
  const attrs = new Set<string>();
  for (const root of [document.body, container]) {
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = el.getAttribute(attr);
        if (value) attrs.add(value);
      }
    });
  }
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
  return { text, attrs };
}

const readableStrings = snapshotDom;

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function domHas(dom: DomSnapshot, value: string): boolean {
  return dom.attrs.has(value) || dom.text.includes(value.replace(/\s+/g, ' '));
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: DomSnapshot, afterDom: DomSnapshot): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      domHas(englishDom, english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        domHas(afterDom, pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: HTMLElement): DomSnapshot {
  act(() => setLocale(PSEUDO_LOCALE));
  const snap = snapshotDom(container);
  act(() => setLocale(BASELINE_LOCALE));
  return snap;
}

const RESET_STATE = {
  pinboardEntities: new Set<string>(),
  isolatedEntities: null,
  basketViews: [] as BasketView[],
  activeBasketViewId: null,
};

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

describe('PresentationPanel localization (#5508)', () => {
  it('translates the action row and empty-strip hint with an empty basket', () => {
    const container = render(<PresentationPanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'presentationPanel.inBasketCount', params: { count: 0 } },
        { key: 'presentationPanel.viewsCount', params: { count: 0 } },
        { key: 'presentationPanel.setFromContextTitle' },
        { key: 'presentationPanel.addToBasketTitle' },
        { key: 'presentationPanel.removeFromBasketTitle' },
        { key: 'presentationPanel.showActiveBasketTitle' },
        { key: 'presentationPanel.clearActiveBasketTitle' },
        { key: 'presentationPanel.saveCurrentViewTitle' },
        { key: 'presentationPanel.playAllTitle' },
        { key: 'presentationPanel.scrollLeftTitle' },
        { key: 'presentationPanel.scrollRightTitle' },
        { key: 'presentationPanel.emptyStripHint' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates a saved-view card: active badge, object/transition counts, and per-card titles', () => {
    useViewerStore.setState({
      activeBasketViewId: 'view-1',
      basketViews: [
        {
          id: 'view-1',
          name: 'My View',
          entityRefs: ['a', 'b'],
          thumbnailDataUrl: null,
          transitionMs: 1500,
          viewpoint: null,
          section: null,
          source: 'manual',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const container = render(<PresentationPanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'presentationPanel.activeBadge' },
        { key: 'presentationPanel.objectsCount', params: { count: 2 } },
        { key: 'presentationPanel.transitionSuffix', params: { duration: '1.5' } },
        { key: 'presentationPanel.renameViewTitle' },
        { key: 'presentationPanel.setTransitionTitle' },
        { key: 'presentationPanel.deleteViewTitle' },
        { key: 'presentationPanel.viewsCount', params: { count: 1 } },
      ],
      englishDom,
      afterDom,
    );
  });
});
