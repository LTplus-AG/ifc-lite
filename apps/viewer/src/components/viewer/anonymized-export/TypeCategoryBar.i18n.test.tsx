/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `TypeCategoryBar`'s own chrome reads the i18n catalogue
 * (`anonymized-export.en.ts`, #4918 slice: anonymized export).
 *
 * This test exists specifically as the revert-oracle's witness for a review
 * fix on #5079 (merged): the "N blocked · click a category to block it"
 * line used to concatenate two separately translated pieces
 * (`blockedCountPrefix` + `clickToBlockHint`), which the i18n README's rule
 * against assembling translated fragments flags — a translation could not
 * reorder the count relative to the instruction. It is now one count-aware
 * key, `blockedClickToBlockHint`, asserted here as a single unit.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { anonymizedExportEn as AnonymizedExportEnType } from '@/i18n/catalogues/anonymized-export.en';
import type { TypeCategory } from './useAnonymizedExportSet.js';
import { TypeCategoryBar } from './TypeCategoryBar.js';

let anonymizedExportEn: typeof AnonymizedExportEnType | undefined;
try {
  ({ anonymizedExportEn } = await import('@/i18n/catalogues/anonymized-export.en'));
} catch {
  anonymizedExportEn = undefined;
}
const CATALOGUE = anonymizedExportEn ?? ({} as typeof AnonymizedExportEnType);

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE) as [string, TranslationValue][]) {
    catalogue[key] = typeof value === 'string' ? marked(value) : { one: marked(value.one ?? value.other), other: marked(value.other) };
  }
  return catalogue;
}

const PSEUDO_LOCALE = 'type-category-bar-pseudo';

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

const CATEGORIES: TypeCategory[] = [
  { typeName: 'IfcWall', count: 4, excluded: true, locked: false },
  { typeName: 'IfcDoor', count: 2, excluded: false, locked: false },
];

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('TypeCategoryBar localization (#4918)', () => {
  it('renders the count-aware blocked hint as one complete message (regression: #5079 review)', () => {
    const container = render(<TypeCategoryBar categories={CATEGORIES} onToggle={() => {}} />);
    const english = readableStrings(container);

    const template = CATALOGUE['anonymizedExport.typeCategoryBar.blockedClickToBlockHint'] as string;
    assert.equal(typeof template, 'string');
    const expectedEnglish = template.replace('{count}', '1');
    assert.ok(english.has(expectedEnglish), `expected combined blocked hint "${expectedEnglish}" on screen`);

    registerLocale(PSEUDO_LOCALE, pseudoLocale());
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readableStrings(container);
    act(() => setLocale('en'));

    assert.ok(
      after.has(marked(expectedEnglish)),
      `expected the combined blocked hint to re-translate as one unit; got: ${[...after].join(', ')}`,
    );
  });
});
