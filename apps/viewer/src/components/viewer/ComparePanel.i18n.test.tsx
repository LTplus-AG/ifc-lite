/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ComparePanel`'s own chrome reads the i18n catalogue (#4918 compare
 * slice, `compare-panel.en.ts`): the header title and its clear/close
 * actions, the "load a second model" empty state, the count badges, and
 * the "raise a BCF topic" affordance it mounts (`BcfFromChange`).
 *
 * Same pseudo-locale oracle as `LayersPanel.i18n.test.tsx`: every asserted
 * key is mapped to a marked copy of its English text, the panel is driven
 * through two store states (fewer than two models loaded; two models with
 * a fabricated one-entry comparison result selected), the locale is
 * switched live, and every marked string that was visible in English must
 * reappear marked.
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
import type { FederatedModel } from '@/store/types.js';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import type { ModelDiff } from '@ifc-lite/diff';
import { ComparePanel } from './ComparePanel.js';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(
    ([key]) =>
      key.startsWith('comparePanel.panel.') ||
      key.startsWith('comparePanel.resultsList.') ||
      key.startsWith('comparePanel.bcfFromChange.'),
  ),
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
const PSEUDO_LOCALE = 'compare-panel-pseudo';

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

function model(id: string): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 10,
  } as FederatedModel;
}

function compareRef(modelId: string, localId: number): CompareRef {
  return { modelId, localId, globalId: localId, drawable: false } as CompareRef;
}

function oneModifiedEntryResult(): CompareResult {
  const ref = compareRef('B', 1);
  const diff = {
    scope: 'both',
    excludedTypes: [],
    entries: [
      {
        key: 'guid-1',
        state: 'modified',
        changeKinds: ['data'],
        base: { key: 'guid-1', ifcType: 'IfcWall', ref: compareRef('A', 1) },
        head: { key: 'guid-1', ifcType: 'IfcWall', ref },
      },
    ],
    byKey: new Map([
      [
        'guid-1',
        {
          key: 'guid-1',
          state: 'modified',
          changeKinds: ['data'],
          base: { key: 'guid-1', ifcType: 'IfcWall', ref: compareRef('A', 1) },
          head: { key: 'guid-1', ifcType: 'IfcWall', ref },
        },
      ],
    ]),
    counts: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
  } as unknown as ModelDiff<CompareRef>;
  return {
    baseModelId: 'A',
    headModelId: 'B',
    baseName: 'A.ifc',
    headName: 'B.ifc',
    scope: 'both',
    geometryUnavailable: false,
    diff,
  } as unknown as CompareResult;
}

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map(),
    compareBaseModelId: null,
    compareHeadModelId: null,
    compareResult: null,
    compareSelectedKey: null,
    compareRunning: false,
    compareError: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map(),
    compareBaseModelId: null,
    compareHeadModelId: null,
    compareResult: null,
    compareSelectedKey: null,
    compareRunning: false,
    compareError: null,
  });
});

describe('ComparePanel localization (#4918)', () => {
  for (const modelCount of [2, 3] as const) {
    it(`#5820 retains a stale comparison and shows Re-run (${modelCount} models)`, () => {
      useViewerStore.setState({
        models: new Map(Array.from({ length: modelCount }, (_, index) => {
          const id = String.fromCharCode(65 + index);
          return [id, model(id)] as const;
        })),
        compareBaseModelId: 'A',
        compareHeadModelId: 'B',
        mutationVersion: 10,
        geometryContentVersion: 20,
      });
      const report = stampAnalysisReport(oneModifiedEntryResult(), captureAnalysisStamp());
      useViewerStore.setState({ compareResult: report });
      const ui = render(<ComparePanel />);
      assert.equal(ui.querySelector('output'), null);

      act(() => useViewerStore.setState({ mutationVersion: 11 }));
      assert.equal(useViewerStore.getState().compareResult, report);
      assert.match(ui.querySelector('output')?.textContent ?? '', /model changed/i);
      assert.ok(ui.querySelector('.opacity-60'), 'the old comparison is dimmed');
      const rerun = ui.querySelector<HTMLButtonElement>('output button');
      assert.equal(rerun?.textContent?.trim(), 'Re-run');
      if (modelCount === 2) {
        assert.ok(rerun);
        click(rerun);
        assert.equal(useViewerStore.getState().compareError, 'Version A is not fully loaded yet.');
        assert.equal(useViewerStore.getState().compareResult, report, 'a failed re-run leaves the stale report visible');
      }
    });
  }

  it('translates the header and the "load a second model" empty state with fewer than two models', () => {
    const container = render(<ComparePanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'comparePanel.panel.title' },
        { key: 'comparePanel.panel.closeTitle' },
        { key: 'comparePanel.panel.loadSecondModel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the clear-results action, count labels, and the focused change\'s BCF affordance', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A')],
        ['B', model('B')],
      ]),
      compareBaseModelId: 'A',
      compareHeadModelId: 'B',
      compareResult: oneModifiedEntryResult(),
      compareSelectedKey: 'guid-1',
    });
    const container = render(<ComparePanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'comparePanel.panel.clearResultsTitle' },
        { key: 'comparePanel.panel.countUnchanged' },
        { key: 'comparePanel.resultsList.stateChanged' },
        { key: 'comparePanel.bcfFromChange.createButton' },
      ],
      englishDom,
      afterDom,
    );
  });
});
