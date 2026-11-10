// SPDX-License-Identifier: MPL-2.0
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store/index.js';
import { registerLocale, resolve, setLocale } from '@/i18n/registry.js';
import { miscPanelsBDe } from '@/i18n/locales/de/misc-panels-b.js';
import { miscPanelsBFr } from '@/i18n/locales/fr/misc-panels-b.js';
import { miscPanelsBRu } from '@/i18n/locales/ru/misc-panels-b.js';
import { LoadReportPanel } from './LoadReportPanel.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); setLocale('en'); useViewerStore.setState(initial); });

// #9268: translated status/rows must not say Clean for a budget-only load.
// Actions, like the existing CSG/drop actions, are report text in every locale.
for (const [locale, catalogue] of [['en', {}], ['de', miscPanelsBDe],
  ['fr', miscPanelsBFr], ['ru', miscPanelsBRu], ['it', {}]] as const) {
  it(`issue 9268 budget-only Load Report is visible in ${locale}`, () => {
    if (locale !== 'en') registerLocale(locale, catalogue);
    setLocale(locale);
    const diagnostics = {
      schemaVersion: 5, totalCsgFailures: 0, productsWithFailures: 0, hostsWithOpenings: 0,
      classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
      failuresByReason: [], silentNoOps: 0, worstHosts: [],
      rectFast: { fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0,
        deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0 },
      totalBudgetRefusals: 1, budgetRefusals: [{ budget: 'walk Items members', limit: 4,
        reached: 5, sourceId: 170, productId: 100, productType: 'IfcWall', GlobalId: 'wall-guid' }],
    };
    useViewerStore.setState(fixtureModels({ ...fixtureModel('m'), diagnostics }));
    const ui = render(<LoadReportPanel />);
    assert.ok(ui.textContent?.includes(resolve('loadReportPanel.status.issuesFound')));
    assert.ok(!ui.textContent?.includes(resolve('loadReportPanel.status.clean')));
    assert.match(ui.textContent ?? '', /1 work budget refusal.*missing or incomplete/);
    assert.match(ui.textContent ?? '', /#100 IfcWall/);
  });
}
