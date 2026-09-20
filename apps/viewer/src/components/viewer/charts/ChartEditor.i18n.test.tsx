/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ChartEditor` reads the i18n catalogue (#4918): its field labels
 * (Title/Source/Chart/Group by/Stack by/Measure/Top N/Order),
 * aria-labels, the "Sum of {column}" measure options, the source-row's
 * row-count/no-rows states, and the Cancel/Save buttons. Column/field
 * NAMES (`c.label`, `SOURCE_LABELS`) are runtime data, not literals, and
 * stay out of `STATIC_KEYS` coverage — same reasoning as every other
 * slice's model-content exclusions.
 *
 * Same oracle shape as `PrivacyPanel.i18n.test.tsx`: a pseudo-locale marks
 * every `chartEditor.*` string, the editor is mounted twice — a `bar`
 * chart with rows loaded (covers Group by, Measure/Count, the row-count
 * label) and a `stackedBar` chart over an empty dataset (covers Stack by
 * and the "nothing loaded" label) — the locale is switched live, and
 * every marked string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ChartDataset, ChartSource, ChartSpec } from '@ifc-lite/charts';
import { render, cleanup } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { chartsEn } from '@/i18n/catalogues/charts.en';
import type { ElementFieldCatalog } from '@/lib/charts/element-field-reader';
import { ChartEditor } from './ChartEditor.js';

type ChartKey = keyof typeof chartsEn;
const ALL_KEYS = Object.keys(chartsEn) as ChartKey[];
const SCOPE_KEYS = ALL_KEYS.filter((key) => key.startsWith('chartEditor.'));
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = chartsEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ChartKey) => `⟦${key}|${String(chartsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

const EMPTY_CATALOG: ElementFieldCatalog = { attributes: [], properties: new Map(), quantities: new Map(), relations: [] };

function dataset(source: ChartSource, rows: ChartDataset['rows']): ChartDataset {
  return {
    source,
    fingerprint: String(rows.length),
    columns: [
      { id: 'IfcType', label: 'IFC type', kind: 'category' },
      { id: 'Area', label: 'Area', kind: 'number', unit: 'm²' },
      { id: 'Level', label: 'Level', kind: 'category' },
    ],
    rows,
  };
}

function allDatasets(elementsRows: ChartDataset['rows']): Record<ChartSource, ChartDataset> {
  return {
    elements: dataset('elements', elementsRows),
    clash: dataset('clash', []),
    bcf: dataset('bcf', []),
    schedule: dataset('schedule', []),
    ids: dataset('ids', []),
    compare: dataset('compare', []),
  };
}

/** A `bar` chart over ELEMENTS with rows loaded — covers Group by, the
 *  row-count label, and the Count measure option. */
function mountWithRows(onSave: (spec: ChartSpec) => void): HTMLElement {
  const spec: ChartSpec = {
    id: 'c1', title: 'Elements by type', source: 'elements', type: 'bar',
    dimension: 'IfcType', measure: { agg: 'count' },
  };
  const datasets = allDatasets([{ ids: [1], values: ['IfcWall', 10, 'Level 1'] }]);
  return render(
    <ChartEditor spec={spec} datasets={datasets} onSave={onSave} onCancel={() => {}} elementFieldCatalog={EMPTY_CATALOG} elementFieldCatalogLoading={false} />,
  );
}

/** A `stackedBar` chart over CLASH (an empty dataset) — covers Stack by
 *  and the "nothing loaded for this source yet" label. */
function mountEmptyStacked(onSave: (spec: ChartSpec) => void): HTMLElement {
  const spec: ChartSpec = {
    id: 'c2', title: 'Clash by severity', source: 'clash', type: 'stackedBar',
    dimension: 'IfcType', stackBy: 'Level', measure: { agg: 'count' },
  };
  const datasets = allDatasets([]);
  return render(
    <ChartEditor spec={spec} datasets={datasets} onSave={onSave} onCancel={() => {}} elementFieldCatalog={EMPTY_CATALOG} elementFieldCatalogLoading={false} />,
  );
}

/** A `bar` chart with a `Sum of {column}` measure option available — covers `sumOfOption`. */
function mountWithNumberColumn(onSave: (spec: ChartSpec) => void): HTMLElement {
  const spec: ChartSpec = {
    id: 'c3', title: 'Area by level', source: 'elements', type: 'bar',
    dimension: 'Level', measure: { agg: 'sum', column: 'Area' },
  };
  const datasets = allDatasets([{ ids: [1], values: ['IfcWall', 10, 'Level 1'] }]);
  return render(
    <ChartEditor spec={spec} datasets={datasets} onSave={onSave} onCancel={() => {}} elementFieldCatalog={EMPTY_CATALOG} elementFieldCatalogLoading={false} />,
  );
}

/** `sourceFilterNotApplicable` needs a `bcf`/`compare` source, which none
 *  of the three fixtures below use (all three sources accept a filter). */
const NOT_RENDERED_IN_THIS_STATE: ChartKey[] = ['chartEditor.sourceFilterNotApplicable'];

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ChartEditor localization (#4918)', () => {
  it('translates every static key rendered across the rows-loaded, empty-source, and number-column states', () => {
    const noop = () => {};
    const containers = [mountWithRows(noop), mountEmptyStacked(noop), mountWithNumberColumn(noop)];

    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);

    registerLocale('chart-editor-pseudo', PSEUDO);
    act(() => setLocale('chart-editor-pseudo'));
    const after = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) after.add(s);

    const covered = new Set<ChartKey>();
    for (const key of STATIC_KEYS) {
      const text = String(chartsEn[key]);
      if (!foundText(english, text)) continue;
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, or documented as not rendered in this state', () => {
    const noop = () => {};
    const containers = [mountWithRows(noop), mountEmptyStacked(noop), mountWithNumberColumn(noop)];
    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);

    const seen = STATIC_KEYS.filter((key) => foundText(english, String(chartsEn[key])));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter((key) => seen.includes(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });

  it('interpolates the row-count label and the Sum-of measure option under a live locale switch', () => {
    registerLocale('fr-FR', {
      'chartEditor.sourceLabelWithCount': 'Source ({count} lignes, fr)',
      'chartEditor.sourceLabelEmpty': 'Source (rien de chargé, fr)',
      'chartEditor.sumOfOption': 'Somme de {column}{unit} (fr)',
    } as Catalogue);
    setLocale('fr-FR');

    const rowsContainer = mountWithRows(() => {});
    assert.match(rowsContainer.textContent ?? '', /Source \(1 lignes, fr\)/);

    const emptyContainer = mountEmptyStacked(() => {});
    assert.match(emptyContainer.textContent ?? '', /Source \(rien de chargé, fr\)/);

    const numberContainer = mountWithNumberColumn(() => {});
    assert.match(numberContainer.textContent ?? '', /Somme de Area \(m²\) \(fr\)/);
  });
});
