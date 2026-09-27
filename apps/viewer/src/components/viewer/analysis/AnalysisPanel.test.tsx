/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The analysis-panel scaffold (#5834), driven through a real panel: the IDS
 * panel, the first one moved onto it. Every assertion is on what the user
 * sees or what the click changed in the store, never on the scaffold's
 * props, so a panel that stopped wiring a slot fails here.
 *
 * Covered: the header run slot (Re-run the result on screen, Cancel while a
 * run is in flight), the one progress component, the one error surface, the
 * stale region, the export split button, the virtualised result list, the
 * demo-data empty state, and the shared catalogue under a live locale switch.
 * At 1 model and at N models where the model count changes the outcome.
 */

import '@/test/setup-dom.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry.js';
import { analysisPanelEn } from '@/i18n/catalogues/analysis-panel.en';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { EVENT_LOAD_FILE } from '@/lib/tours/events';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import type { IDSDocument, IDSValidationReport } from '@ifc-lite/ids';
import { IDSPanel } from '../IDSPanel.js';

installLayout();
const initial = useViewerStore.getState();
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../public');

const documentFixture: IDSDocument = {
  info: { title: 'Fixture IDS', version: '1.0' },
  specifications: [{
    id: 'spec-a',
    name: 'Wall requirements',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    requirements: [],
  }],
};

function reportFor(modelId: string, entityCount = 1): IDSValidationReport {
  const entityResults = Array.from({ length: entityCount }, (_, i) => ({
    expressId: i + 1, modelId, entityType: 'IfcWall', entityName: `Wall ${i + 1}`, passed: false, requirementResults: [],
  }));
  return {
    source: { kind: 'ids', document: documentFixture },
    modelInfo: [{ modelId, schemaVersion: 'IFC4', entityCount }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: entityCount, totalEntitiesPassed: 0, totalEntitiesFailed: entityCount, overallPassRate: 0,
    },
    specificationResults: [{
      specification: documentFixture.specifications[0],
      status: 'fail', applicableCount: entityCount, passedCount: 0, failedCount: entityCount, passRate: 0,
      entityResults,
    }],
  };
}

function seedModels(modelCount: 1 | 2): void {
  useViewerStore.setState(modelCount === 1
    ? fixtureModels(fixtureModel('model-a', { entities: [{ expressId: 1, type: 'IfcWall' }] }))
    : fixtureModels(
      fixtureModel('model-a', { entities: [{ expressId: 1, type: 'IfcWall' }] }),
      fixtureModel('model-b', { idOffset: 100, entities: [{ expressId: 1, type: 'IfcWall' }] }),
    ));
}

const buttons = (root: ParentNode): HTMLButtonElement[] => [...root.querySelectorAll('button')];
const byLabel = (root: ParentNode, label: string) => buttons(root).find((b) => b.getAttribute('aria-label') === label);
const byText = (root: ParentNode, text: string) => buttons(root).find((b) => b.textContent?.trim() === text);

afterEach(() => {
  cleanup();
  clearDownloads();
  setLocale('en');
  useViewerStore.setState({
    ...initial,
    models: new Map(),
    activeModelId: null,
    idsDocument: null,
    idsValidationReport: null,
    idsAuditReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
});

describe('AnalysisPanel scaffold, through the IDS panel (#5834)', () => {
  for (const modelCount of [1, 2] as const) {
    it(`the header run slot offers Re-run for the result on screen and Cancel while a run is in flight (${modelCount} model(s))`, () => {
      seedModels(modelCount);
      useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
      const ui = render(<IDSPanel />);

      const rerun = byLabel(ui, 'Re-run validation');
      assert.ok(rerun, 'Re-run sits in the header once a result exists');
      assert.equal(rerun.textContent?.trim(), 'Re-run');

      act(() => useViewerStore.setState({
        idsLoading: true,
        idsProgress: { phase: 'validating', specificationIndex: 0, totalSpecifications: 1, entitiesProcessed: 3, totalEntities: 10, percentage: 30 },
      }));
      const cancel = byLabel(ui, 'Cancel validation');
      assert.ok(cancel, 'the same slot turns into Cancel while the run is in flight');
      assert.equal(cancel.textContent?.trim(), 'Cancel');
      assert.equal(byLabel(ui, 'Re-run validation'), undefined);
      click(cancel);
      assert.equal(useViewerStore.getState().idsLoading, false, 'Cancel stopped the run');
      assert.equal(useViewerStore.getState().idsProgress, null);
      assert.ok(byLabel(ui, 'Re-run validation'), 'and the slot is Re-run again');
    });
  }

  it('shows no run slot and no Clear results before the first result', () => {
    useViewerStore.setState({ idsDocument: documentFixture });
    const ui = render(<IDSPanel />);
    assert.equal(byLabel(ui, 'Re-run validation'), undefined);
    assert.equal(byLabel(ui, 'Clear results'), undefined);
    assert.ok(byText(ui, 'Run Validation'), 'the first run stays in the body');
  });

  it('renders the run\'s progress in the one progress component, and its error in the one error surface', () => {
    seedModels(1);
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsLoading: true,
      idsProgress: { phase: 'validating', specificationIndex: 0, totalSpecifications: 2, entitiesProcessed: 3, totalEntities: 10, percentage: 30 },
    });
    const ui = render(<IDSPanel />);
    const progress = ui.querySelector('output');
    assert.ok(progress, 'progress renders as a status region');
    assert.match(progress.textContent ?? '', /1.*2/, 'names the specification being checked');
    assert.match(progress.textContent ?? '', /3.*10/, 'and the entities done so far');

    act(() => useViewerStore.setState({ idsLoading: false, idsProgress: null, idsError: { labelKey: 'idsPanel.error.noModelLoaded' } }));
    assert.equal(ui.querySelector('output'), null, 'progress is gone once the run settles');
    const alert = ui.querySelector('[role="alert"]');
    assert.equal(alert?.textContent?.trim(), resolve('idsPanel.error.noModelLoaded'));
  });

  it('dims only the result region while the result is stale, and not before', () => {
    seedModels(1);
    useViewerStore.setState({ idsDocument: documentFixture, mutationVersion: 1, geometryContentVersion: 1 });
    useViewerStore.setState({ idsValidationReport: stampAnalysisReport(reportFor('model-a'), captureAnalysisStamp()) });
    const ui = render(<IDSPanel />);
    assert.equal(ui.querySelector('.opacity-60'), null);
    act(() => useViewerStore.setState({ geometryContentVersion: 2 }));
    const dimmed = ui.querySelector('.opacity-60');
    assert.ok(dimmed?.textContent?.includes('Wall requirements'), 'the report is what dims');
    assert.ok(!dimmed?.contains(byLabel(ui, 'Re-run validation') ?? null), 'the header stays live');
  });

  it('exports in the chosen format and remembers it as the split button\'s default', async () => {
    seedModels(1);
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const ui = render(<IDSPanel />);
    const main = byLabel(ui, 'Export Report (HTML)');
    assert.ok(main, 'the main button exports the default format');
    assert.ok(main.querySelector('svg.lucide-download'), 'export shows Download (#5822)');

    const chooser = byLabel(ui, resolve('analysisPanel.export.chooseFormat'));
    assert.ok(chooser);
    act(() => {
      chooser.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      chooser.click();
    });
    const json = [...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes('JSON Report'));
    assert.ok(json, 'the chevron lists every format');
    await act(async () => { (json as HTMLElement).click(); });
    assert.ok(downloadedNames().some((name) => name.endsWith('.json')), `a JSON report was saved: ${downloadedNames().join(', ')}`);
    assert.ok(byLabel(ui, 'Export Report (JSON)'), 'JSON is now the main button\'s format');
  });

  it('lists a large result through the virtualised list, mounting only a window of it', () => {
    seedModels(1);
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a', 400) });
    const ui = render(<IDSPanel />);
    const spec = byText(ui, 'Wall requirements') ?? buttons(ui).find((b) => b.textContent?.includes('Wall requirements'));
    assert.ok(spec);
    click(spec);
    const list = ui.querySelector('[data-ids-entity-results]');
    assert.ok(list, 'the entity list renders');
    const mounted = list.querySelectorAll('[data-index]').length;
    assert.ok(mounted > 0 && mounted < 400, `a window of the 400 rows is mounted, not all of them (${mounted})`);
  });

  describe('"Try with demo data"', () => {
    it('is not offered while the user\'s own model is loaded, so it never replaces it', () => {
      seedModels(1);
      const ui = render(<IDSPanel />);
      assert.equal(byText(ui, 'Try with demo data'), undefined);
    });

    it('with nothing loaded, loads the demo project and then the demo IDS', async () => {
      const originalFetch = globalThis.fetch;
      const fetched: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        fetched.push(url);
        return new Response(await readFile(path.join(PUBLIC_DIR, url)));
      }) as typeof fetch;
      const loaded: File[] = [];
      const onLoad = (event: Event) => {
        loaded.push((event as CustomEvent<File>).detail);
        // What the viewer's load pipeline does on this event, minus parsing.
        useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('demo'), name: (event as CustomEvent<File>).detail.name }), loading: false, geometryStreamingActive: false });
      };
      window.addEventListener(EVENT_LOAD_FILE, onLoad);
      try {
        const ui = render(<IDSPanel />);
        const demo = byText(ui, 'Try with demo data');
        assert.ok(demo, 'offered while nothing is loaded');
        await act(async () => {
          demo.click();
          for (let i = 0; i < 100 && !useViewerStore.getState().idsDocument; i++) await new Promise((r) => setTimeout(r, 10));
        });
        assert.deepEqual(loaded.map((f) => f.name), ['building-architecture.ifc'], 'the demo project was loaded first');
        assert.deepEqual(fetched, ['/samples/building-architecture.ifc', '/samples/building-architecture.ids']);
        assert.ok(useViewerStore.getState().idsDocument, 'then the demo IDS');
        assert.equal(byText(ui, 'Try with demo data'), undefined, 'the empty state is gone');
      } finally {
        window.removeEventListener(EVENT_LOAD_FILE, onLoad);
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('follows a live locale switch in the shared chrome', () => {
    seedModels(1);
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const pseudo: Catalogue = Object.fromEntries(Object.entries(analysisPanelEn).map(([key, value]) => [key, `⟦${value}⟧`]));
    registerLocale('analysis-panel-pseudo', pseudo);
    const ui = render(<IDSPanel onClose={() => {}} />);
    act(() => setLocale('analysis-panel-pseudo'));
    assert.ok(byText(ui, '⟦Re-run⟧'), 'run slot');
    assert.ok(byLabel(ui, '⟦Clear results⟧'), 'clear results');
    assert.ok(byLabel(ui, '⟦Close⟧'), 'close');
    assert.ok(byLabel(ui, '⟦Choose export format⟧'), 'export chooser');
  });
});
