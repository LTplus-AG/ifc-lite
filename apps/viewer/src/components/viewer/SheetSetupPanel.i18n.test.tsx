/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SheetSetupPanel`'s own chrome reads the i18n catalogue (#4918 sheets/PDF
 * slice, `sheets-pdf.en.ts`, `sheetsPdf.sheetSetup.*`): the enable toggle
 * (its own title-free header since #5495 — the Drawing inspector's Sheet tab
 * carries the title now), the disabled-sheet empty state, every section
 * heading and toggle label, the
 * frame-style/title-block-layout option lists (moved to a `labelKey` data
 * table the same way `sectionConstants.ts`'s `AXIS_INFO` is), the templated
 * dimension/margin/fields-configured readouts, and the saved-templates list
 * chrome. Paper size NAMES and every millimetre figure are interpolation
 * params, not translated text, per the house rule on units/symbols.
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
import { SheetSetupPanel } from './SheetSetupPanel.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('sheetsPdf.sheetSetup.')),
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
const PSEUDO_LOCALE = 'sheet-setup-panel-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    // Each text-node child is its own DOM entry (not joined): two adjacent
    // `{t(...)}` expressions split by a `<br />` (the title-block dimensions
    // / fields-configured readout) are two separate strings on screen, and
    // joining them would hide either one from this set.
    for (const node of el.childNodes) {
      if (node.nodeType !== node.TEXT_NODE) continue;
      const text = (node.textContent ?? '').trim();
      if (text) out.add(text);
    }
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
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ activeSheet: null, sheetEnabled: false, savedSheetTemplates: [] });
});

describe('SheetSetupPanel localization (#4918)', () => {
  it('translates the header and the disabled-sheet empty state', () => {
    useViewerStore.setState({ activeSheet: null, sheetEnabled: false });
    const container = render(<SheetSetupPanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'sheetsPdf.sheetSetup.enabledToggleLabel' },
        { key: 'sheetsPdf.sheetSetup.enablePrompt' },
        { key: 'sheetsPdf.sheetSetup.enableButton' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates every section heading, option label, and templated readout with an active sheet', () => {
    useViewerStore.setState({ activeSheet: createDefaultSheet(), sheetEnabled: true, savedSheetTemplates: [] });
    const container = render(<SheetSetupPanel />);
    // "Saved Templates" starts collapsed; open it so its empty-state text renders.
    const templatesTrigger = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(resolve('sheetsPdf.sheetSetup.savedTemplatesHeading' as never)),
    );
    assert.ok(templatesTrigger, 'Saved Templates trigger not found');
    click(templatesTrigger!);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    const sheet = useViewerStore.getState().activeSheet!;
    assertAllTranslate(
      [
        { key: 'sheetsPdf.sheetSetup.paperSizeHeading' },
        {
          key: 'sheetsPdf.sheetSetup.paperDimensions',
          params: { width: sheet.paper.widthMm, height: sheet.paper.heightMm },
        },
        { key: 'sheetsPdf.sheetSetup.frameStyleHeading' },
        { key: 'sheetsPdf.sheetSetup.frameStyleProfessional' },
        {
          key: 'sheetsPdf.sheetSetup.margins',
          params: {
            top: sheet.frame.margins.top,
            right: sheet.frame.margins.right,
            bottom: sheet.frame.margins.bottom,
            left: sheet.frame.margins.left,
          },
        },
        { key: 'sheetsPdf.sheetSetup.drawingScaleHeading' },
        { key: 'sheetsPdf.sheetSetup.titleBlockHeading' },
        { key: 'sheetsPdf.sheetSetup.layoutLabel' },
        { key: 'sheetsPdf.sheetSetup.layoutStandard' },
        {
          key: 'sheetsPdf.sheetSetup.titleBlockDimensions',
          params: { width: sheet.titleBlock.widthMm, height: sheet.titleBlock.heightMm },
        },
        { key: 'sheetsPdf.sheetSetup.fieldsConfigured', params: { count: sheet.titleBlock.fields.length } },
        { key: 'sheetsPdf.sheetSetup.editTitleBlockFieldsButton' },
        { key: 'sheetsPdf.sheetSetup.scaleBarNorthArrowHeading' },
        { key: 'sheetsPdf.sheetSetup.scaleBarLabel' },
        { key: 'sheetsPdf.sheetSetup.northArrowLabel' },
        { key: 'sheetsPdf.sheetSetup.savedTemplatesHeading' },
        { key: 'sheetsPdf.sheetSetup.noSavedTemplates' },
        {
          key: 'sheetsPdf.sheetSetup.drawingAreaValue',
          params: {
            width: sheet.viewportBounds.width.toFixed(1),
            height: sheet.viewportBounds.height.toFixed(1),
          },
        },
        { key: 'sheetsPdf.sheetSetup.drawingAreaLabel' },
        { key: 'sheetsPdf.sheetSetup.scaleLabel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the saved-templates placeholder and a template row', () => {
    useViewerStore.setState({
      activeSheet: createDefaultSheet(),
      sheetEnabled: true,
      savedSheetTemplates: [{ ...createDefaultSheet(), id: 'tmpl-1', name: 'My Template' }],
    });
    const container = render(<SheetSetupPanel />);
    const templatesTrigger = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(resolve('sheetsPdf.sheetSetup.savedTemplatesHeading' as never)),
    );
    assert.ok(templatesTrigger, 'Saved Templates trigger not found');
    click(templatesTrigger!);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'sheetsPdf.sheetSetup.templateNamePlaceholder' },
        { key: 'sheetsPdf.sheetSetup.loadTemplate', params: { name: 'My Template' } },
        { key: 'sheetsPdf.sheetSetup.deleteTemplate', params: { name: 'My Template' } },
      ],
      englishDom,
      afterDom,
    );
    assert.ok(container.querySelector('button[aria-label="Load template My Template"]'));
    assert.ok(container.querySelector('button[aria-label="Delete template My Template"]'));
    // The saved template's own NAME is user data, not a catalogue key.
    assert.ok(englishDom.has('My Template'), 'the template name must render as-is');
    assert.ok(afterDom.has('My Template'), 'the template name must not be marked by the pseudo-locale');
  });
});
