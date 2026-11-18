// SPDX-License-Identifier: MPL-2.0
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store/index.js';
import { registerLocale, resolve, resolveEnglish, setLocale } from '@/i18n/registry.js';
import { miscPanelsBDe } from '@/i18n/locales/de/misc-panels-b.js';
import { miscPanelsBFr } from '@/i18n/locales/fr/misc-panels-b.js';
import { miscPanelsBRu } from '@/i18n/locales/ru/misc-panels-b.js';
import { miscPanelsBIt } from '@/i18n/locales/it/misc-panels-b.js';
import { LoadReportPanel } from './LoadReportPanel.js';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); setLocale('en'); useViewerStore.setState(initial); });

// #9268: translated status/rows must not say Clean for a budget-only load.
// Actions, like the existing CSG/drop actions, are report text in every locale.
for (const [locale, catalogue] of [['en', {}], ['de', miscPanelsBDe],
  ['fr', miscPanelsBFr], ['ru', miscPanelsBRu], ['it', miscPanelsBIt]] as const) {
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
    // The row says which allowance refused the product, its limit and demand, translated.
    const params = { budget: 'walk Items members', limit: 4, reached: 5, sourceId: 170 };
    const line = resolve('loadReportPanel.budgetRefusal', params);
    assert.notEqual(line, 'loadReportPanel.budgetRefusal');
    // A missing translation falls back to English everywhere, so require the locale's own.
    if (locale !== 'en') assert.notEqual(line, resolveEnglish('loadReportPanel.budgetRefusal', params), `${locale} is untranslated`);
    assert.ok(ui.textContent?.includes(line), `${locale}: ${line}`);
  });
}

// #9268 review: a frameable CSG host that was also refused keeps its select
// button, and the refusal under it describes that button for assistive tech.
it('issue 9268 selectable row carries its budget refusal and describes the button with it', () => {
  setLocale('en');
  const diagnostics = {
    schemaVersion: 5, totalCsgFailures: 1, productsWithFailures: 1, hostsWithOpenings: 1,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [], silentNoOps: 0,
    worstHosts: [{ productId: 42, ifcType: 'IfcWall', openings: 2, csgFailures: 1,
      firstFailureLabel: 'KernelError', bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] } }],
    rectFast: { fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0,
      deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0 },
    totalBudgetRefusals: 1, budgetRefusals: [{ budget: 'logical mapped attempts', limit: 3,
      reached: 4, sourceId: 8, productId: 42, productType: 'IfcWall', GlobalId: null }],
  };
  useViewerStore.setState(fixtureModels({ ...fixtureModel('m'), diagnostics }));
  const ui = render(<LoadReportPanel />);
  const button = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('#42 IfcWall'));
  assert.ok(button, 'the CSG host stays selectable');
  const described = ui.querySelector(`[id="${button.getAttribute('aria-describedby')}"]`);
  assert.equal(described?.textContent, 'logical mapped attempts: limit 3, reached 4; source #8');
});
