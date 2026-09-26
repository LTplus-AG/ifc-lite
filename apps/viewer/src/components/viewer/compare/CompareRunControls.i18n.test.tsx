/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CompareRunControls` reads the i18n catalogue (#4918 compare slice,
 * `compare-panel.en.ts`): the A/B model pickers' own labels, the scope
 * switch, the display/matching toggles and their hint text, the run button
 * (both its idle and in-flight label), the two mutually-exclusive geometry
 * warnings (never fragmented - each is one complete message), and the
 * "ignore a class" picker it mounts (`CompareBlacklist`).
 *
 * Same pseudo-locale oracle as `LayersPanel.i18n.test.tsx`: a locale maps
 * every asserted key to a marked copy of its English text, the component is
 * rendered, the locale is switched live, and the marked text must replace
 * the English text on screen. This is deliberately presentational (see the
 * component's own docblock) - every prop is passed directly, no store.
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
import { CompareRunControls } from './CompareRunControls.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('comparePanel.runControls.') || key.startsWith('comparePanel.blacklist.')),
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
const PSEUDO_LOCALE = 'compare-run-controls-pseudo';

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

const BASE_PROPS = {
  models: [
    { id: 'A', name: 'base.ifc' },
    { id: 'B', name: 'head.ifc' },
  ],
  baseModelId: 'A',
  headModelId: 'B',
  onBaseModelId: () => {},
  onHeadModelId: () => {},
  scope: 'both' as const,
  onScope: () => {},
  showUnchanged: false,
  onShowUnchanged: () => {},
  matchByContent: true,
  onMatchByContent: () => {},
  keyProperty: undefined,
  onKeyProperty: () => {},
  duplicateInfo: null,
  canRun: true,
  running: false,
  onRun: () => {},
  onCancel: () => {},
  error: null,
  geometryUnavailable: false,
  placementOnlyGeometry: false,
  excludedTypes: ['IfcOpeningElement'],
  changedTypeCounts: [{ type: 'IfcWall', count: 3 }],
  onAddExcludedType: () => {},
  onRemoveExcludedType: () => {},
  onClearExcludedTypes: () => {},
};

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

describe('CompareRunControls localization (#4918)', () => {
  it('translates the A/B labels, scope switch, toggles, blacklist chrome and run button', () => {
    const container = render(<CompareRunControls {...BASE_PROPS} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'comparePanel.runControls.baseLabel' },
        { key: 'comparePanel.runControls.headLabel' },
        { key: 'comparePanel.runControls.scopeBoth' },
        { key: 'comparePanel.runControls.scopeData' },
        { key: 'comparePanel.runControls.scopeGeometry' },
        { key: 'comparePanel.runControls.showUnchanged' },
        { key: 'comparePanel.runControls.matchByContentLabel' },
        { key: 'comparePanel.runControls.matchByContentHint' },
        { key: 'comparePanel.runControls.runComparison' },
        { key: 'comparePanel.blacklist.ignoreLabel' },
        { key: 'comparePanel.blacklist.pickerTitle' },
        { key: 'comparePanel.blacklist.pickerPlaceholder' },
        { key: 'comparePanel.blacklist.chipTitle', params: { type: 'IfcOpeningElement' } },
        { key: 'comparePanel.blacklist.removeTitle', params: { type: 'IfcOpeningElement' } },
        { key: 'comparePanel.blacklist.clearLabel' },
        { key: 'comparePanel.blacklist.clearTitle' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates "pick two different models" and the in-flight run label', () => {
    const container = render(<CompareRunControls {...BASE_PROPS} headModelId="A" running canRun={false} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'comparePanel.runControls.pickDifferentModels' },
        { key: 'comparePanel.runControls.cancel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('uses the run button to cancel even if the pair is no longer valid (#5831)', () => {
    let cancelled = 0;
    const container = render(<CompareRunControls {...BASE_PROPS} running canRun={false} onCancel={() => { cancelled += 1; }} />);
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('Cancel comparison'));
    assert.ok(button);
    assert.equal(button.disabled, false);
    click(button);
    assert.equal(cancelled, 1);
  });

  it('translates the placement-only geometry warning as one complete message', () => {
    const container = render(
      <CompareRunControls {...BASE_PROPS} geometryUnavailable placementOnlyGeometry />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [{ key: 'comparePanel.runControls.geometryUnavailablePlacementOnly' }],
      englishDom,
      afterDom,
    );
  });

  it('translates the full geometry-unavailable warning as one complete message', () => {
    const container = render(
      <CompareRunControls {...BASE_PROPS} geometryUnavailable placementOnlyGeometry={false} />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [{ key: 'comparePanel.runControls.geometryUnavailableFull' }],
      englishDom,
      afterDom,
    );
  });
});
