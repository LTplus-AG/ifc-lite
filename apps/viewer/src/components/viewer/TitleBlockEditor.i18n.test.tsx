/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `TitleBlockEditor`'s own chrome reads the i18n catalogue (#4918 sheets/PDF
 * slice, `sheets-pdf.en.ts`, `sheetsPdf.titleBlock.*`): the dialog title,
 * section headings, field-form/logo/revision-form controls, and the empty
 * states. Field VALUES the user types, the standard/custom field LABELS
 * (data from `@ifc-lite/drawing-2d`, not this catalogue), and revision
 * author/date/description content are model data and stay literal — they
 * are asserted separately from the catalogue keys, not marked by the
 * pseudo-locale.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { createDefaultSheet } from '@/store/slices/sheetSlice';
import { TitleBlockEditor } from './TitleBlockEditor.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('sheetsPdf.titleBlock.')),
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
const PSEUDO_LOCALE = 'title-block-editor-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
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
  useViewerStore.setState({ activeSheet: createDefaultSheet(), sheetEnabled: true });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ activeSheet: null, sheetEnabled: false });
});

// `TitleBlockEditor` is a Radix `Dialog`: its content teleports into a
// portal appended to `document.body`, not into the container `render()`
// returns, so every lookup below reads `document.body` directly.
describe('TitleBlockEditor localization (#4918)', () => {
  it('translates the dialog chrome, section headings, and empty states', async () => {
    render(<TitleBlockEditor open onOpenChange={() => {}} />);
    const englishDom = readableStrings(document.body);
    const afterDom = domAfterPseudo(document.body);
    assertAllTranslate(
      [
        { key: 'sheetsPdf.titleBlock.dialogTitle' },
        { key: 'sheetsPdf.titleBlock.standardFieldsHeading' },
        { key: 'sheetsPdf.titleBlock.customFieldsHeading' },
        { key: 'sheetsPdf.titleBlock.addFieldButton' },
        { key: 'sheetsPdf.titleBlock.noCustomFields' },
        { key: 'sheetsPdf.titleBlock.companyLogoHeading' },
        { key: 'sheetsPdf.titleBlock.uploadLogo' },
        { key: 'sheetsPdf.titleBlock.logoFormats' },
        { key: 'sheetsPdf.titleBlock.revisionHistoryHeading' },
        { key: 'sheetsPdf.titleBlock.addRevisionButton' },
        { key: 'sheetsPdf.titleBlock.noRevisions' },
        { key: 'sheetsPdf.titleBlock.done' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates a standard field placeholder using its own (untranslated) label', () => {
    render(<TitleBlockEditor open onOpenChange={() => {}} />);
    const englishDom = readableStrings(document.body);
    const afterDom = domAfterPseudo(document.body);
    // The field label itself ('Project') is model/preset data, not a
    // catalogue key: it must survive the locale switch unmarked.
    assertAllTranslate(
      [{ key: 'sheetsPdf.titleBlock.fieldPlaceholder', params: { label: 'project' } }],
      englishDom,
      afterDom,
    );
    assert.ok(englishDom.has('Project'), 'the field label must render as-is');
    assert.ok(afterDom.has('Project'), 'the field label must not be marked by the pseudo-locale');
  });

  it('translates the new-custom-field form and its buttons', () => {
    render(<TitleBlockEditor open onOpenChange={() => {}} />);
    const addFieldButton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(resolve('sheetsPdf.titleBlock.addFieldButton' as never)),
    );
    assert.ok(addFieldButton, 'Add Field button not found');
    click(addFieldButton!);
    const englishDom = readableStrings(document.body);
    const afterDom = domAfterPseudo(document.body);
    assertAllTranslate(
      [
        { key: 'sheetsPdf.titleBlock.fieldLabelPlaceholder' },
        { key: 'sheetsPdf.titleBlock.addButton' },
        { key: 'sheetsPdf.titleBlock.cancel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the new-revision form fields and by-author text', () => {
    useViewerStore.setState((s) => ({
      activeSheet: {
        ...s.activeSheet!,
        revisions: [{ revision: 'A', date: '2024-01-15', description: 'Initial issue', author: 'LT' }],
      },
    }));
    render(<TitleBlockEditor open onOpenChange={() => {}} />);
    const addRevisionButton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(resolve('sheetsPdf.titleBlock.addRevisionButton' as never)),
    );
    assert.ok(addRevisionButton, 'Add Revision button not found');
    click(addRevisionButton!);
    const englishDom = readableStrings(document.body);
    const afterDom = domAfterPseudo(document.body);
    assertAllTranslate(
      [
        { key: 'sheetsPdf.titleBlock.revisionNumberLabel' },
        { key: 'sheetsPdf.titleBlock.dateLabel' },
        { key: 'sheetsPdf.titleBlock.descriptionLabel' },
        { key: 'sheetsPdf.titleBlock.authorLabel' },
        { key: 'sheetsPdf.titleBlock.byAuthor', params: { author: 'LT' } },
      ],
      englishDom,
      afterDom,
    );
  });
});
