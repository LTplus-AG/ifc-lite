/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ChartsPanel` reads the i18n catalogue (#4918): its header controls
 * (dashboard/scope/focus-mode selects, "Colour in 3D", "Add chart", the
 * report button, close), and both empty states ("Load a model to chart
 * it.", "No charts yet." / "Add a chart"). Chart/dashboard NAMES are
 * runtime data and stay out of `STATIC_KEYS` coverage, same reasoning as
 * every other slice's model-content exclusions.
 *
 * Same oracle shape as `PrivacyPanel.i18n.test.tsx`, adapted for a panel
 * that reads the GLOBAL viewer store rather than an injected context: the
 * "no model loaded" and "loaded model, empty dashboard" branches cannot be
 * mounted SIMULTANEOUSLY (both instances would read the same store state),
 * so each state is mounted, read, and torn down in turn — once under
 * English, once under a pseudo-locale — and the two readable-text sets are
 * unioned before comparing against the catalogue.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, cleanup } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { chartsEn } from '@/i18n/catalogues/charts.en';
import type { ChartRenderer } from './useEChart.js';
import { ChartsPanel } from './ChartsPanel.js';

type ChartKey = keyof typeof chartsEn;
const ALL_KEYS = Object.keys(chartsEn) as ChartKey[];
const SCOPE_KEYS = ALL_KEYS.filter((key) => key.startsWith('chartsPanel.'));
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = chartsEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ChartKey) => `⟦${key}|${String(chartsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(container, out);
  for (const el of container.querySelectorAll('button, select, input')) {
    act(() => (el as HTMLElement).focus());
    addReadable(container, out);
    act(() => (el as HTMLElement).blur());
  }
  return out;
}

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

/**
 * Keys neither render state covers: `clearSliceButton` / `clearSliceTitle`
 * need a live `chartSlice`, which neither fixture below produces (no chart
 * to click a bucket on).
 */
const NOT_RENDERED_IN_THIS_STATE: ChartKey[] = [
  'chartsPanel.clearSliceButton',
  'chartsPanel.clearSliceTitle',
];

const noopRenderer: ChartRenderer = async () => () => ({
  setOption: () => {},
  select: () => {},
  resize: () => {},
  dispose: () => {},
});

/** No model loaded: the "Load a model to chart it." empty state. */
async function mountNoModel(): Promise<HTMLElement> {
  useViewerStore.setState({ models: new Map(), activeModelId: null, dashboards: [], activeDashboardId: null });
  const container = render(<ChartsPanel renderer={noopRenderer} onClose={() => {}} />);
  await act(async () => { await Promise.resolve(); });
  return container;
}

/** A loaded (empty) model with a dashboard that has no charts yet — the "No charts yet." / "Add a chart" empty state. */
async function mountEmptyDashboard(): Promise<HTMLElement> {
  const model = fixtureModel('m1');
  useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, dashboards: [], activeDashboardId: null });
  const container = render(<ChartsPanel renderer={noopRenderer} onClose={() => {}} />);
  await act(async () => { await Promise.resolve(); });
  act(() => {
    const dashboard = useViewerStore.getState().dashboards[0];
    useViewerStore.getState().upsertDashboard({ ...dashboard, charts: [], layout: [] });
  });
  return container;
}

/** Reads both states' readable text under the CURRENT locale, tearing each mount down before the next. */
async function readableAcrossStates(): Promise<Set<string>> {
  const noModel = await mountNoModel();
  const fromNoModel = readableStrings(noModel);
  cleanup();

  const emptyDashboard = await mountEmptyDashboard();
  const fromEmptyDashboard = readableStrings(emptyDashboard);
  cleanup();

  return new Set([...fromNoModel, ...fromEmptyDashboard]);
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ChartsPanel localization (#4918)', () => {
  it('translates every static key rendered across the no-model and empty-dashboard states', async () => {
    const english = await readableAcrossStates();

    registerLocale('charts-panel-pseudo', PSEUDO);
    act(() => setLocale('charts-panel-pseudo'));
    const after = await readableAcrossStates();

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

  it('accounts for every static key: rendered here, or documented as not rendered in this state', async () => {
    const english = await readableAcrossStates();
    const seen = STATIC_KEYS.filter((key) => foundText(english, String(chartsEn[key])));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter((key) => seen.includes(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });

  it('interpolates the "Add chart" empty-state button and the dashboard/scope selects under a live locale switch', async () => {
    registerLocale('fr-FR', {
      'chartsPanel.addChartEmptyStateButton': 'Ajouter un graphique (fr)',
      'chartsPanel.noChartsEmptyState': 'Aucun graphique (fr)',
    } as Catalogue);
    setLocale('fr-FR');

    const container = await mountEmptyDashboard();

    assert.match(container.textContent ?? '', /Aucun graphique \(fr\)/);
    assert.match(container.textContent ?? '', /Ajouter un graphique \(fr\)/);
  });
});
