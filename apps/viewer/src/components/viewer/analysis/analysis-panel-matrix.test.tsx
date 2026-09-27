/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The analysis-panel consistency matrix (#5834, charter #5613): 14 aspects,
 * each asserted on IDS, Clash, Compare and BCF through the real mounted
 * panel, at 1 model and at N models (Compare at 2 and 3: one model is its
 * empty state). The last test reads the matrix back and requires every cell.
 *
 * A cell is either a behaviour the panel shows, or `n/a` where the panel has
 * nothing the aspect governs: BCF runs no analysis, so it has no run slot,
 * nothing that goes stale and no demo data. An `n/a` cell is still ASSERTED,
 * as the absence of the control, so a panel that later grows the capability
 * has to take the shared rule with it.
 *
 * Clash runs the real detection over real meshes (`clash-run-fixture`);
 * IDS, Compare and BCF seed a report, as their own panel tests do.
 */

import '@/test/setup-dom.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import type { IDSDocument, IDSValidationReport } from '@ifc-lite/ids';
import type { ModelDiff } from '@ifc-lite/diff';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { seedCoincidentWalls } from '@/test/clash-run-fixture.js';
import { resolve } from '@/i18n/registry.js';
import { useViewerStore, type FederatedModel } from '@/store';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { EVENT_LOAD_FILE } from '@/lib/tours/events';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { IDSPanel } from '../IDSPanel.js';
import { ClashPanel } from '../ClashPanel.js';
import { ComparePanel } from '../ComparePanel.js';
import { BCFPanel } from '../BCFPanel.js';

installLayout();
const initial = useViewerStore.getState();

type Panel = 'IDS' | 'Clash' | 'Compare' | 'BCF';
const PANELS: Panel[] = ['IDS', 'Clash', 'Compare', 'BCF'];
const ASPECTS = [
  'run slot', 're-run last', 'cancel', 'progress', 'stale', 'result list', 'row click',
  'teardown', 'export', 'icons', 'demo data', 'error', 'clear results', 'remount',
] as const;
type Aspect = (typeof ASPECTS)[number];
const matrix = new Map<string, 'ok' | 'n/a'>();
const mark = (aspect: Aspect, panel: Panel, value: 'ok' | 'n/a' = 'ok') => matrix.set(`${aspect}|${panel}`, value);
/** Compare needs two models; every other panel is exercised at 1 and at N. */
const counts = (panel: Panel): readonly number[] => (panel === 'Compare' ? [2, 3] : [1, 2]);

// ── fixtures ────────────────────────────────────────────────────────────────

const idsDocument: IDSDocument = {
  info: { title: 'Fixture IDS', version: '1.0' },
  specifications: [{ id: 'spec-a', name: 'Wall requirements', ifcVersions: ['IFC4'], applicability: { facets: [] }, requirements: [] }],
};

function idsReport(entityCount = 1): IDSValidationReport {
  return {
    source: { kind: 'ids', document: idsDocument },
    modelInfo: [{ modelId: 'model-a', schemaVersion: 'IFC4', entityCount }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: entityCount, totalEntitiesPassed: 0, totalEntitiesFailed: entityCount, overallPassRate: 0,
    },
    specificationResults: [{
      specification: idsDocument.specifications[0],
      status: 'fail', applicableCount: entityCount, passedCount: 0, failedCount: entityCount, passRate: 0,
      entityResults: Array.from({ length: entityCount }, (_, i) => ({
        expressId: i + 1, modelId: 'model-a', entityType: 'IfcWall', entityName: `Wall ${i + 1}`, passed: false, requirementResults: [],
      })),
    }],
  };
}

function seedIdsModels(n: number): void {
  const entities = [{ expressId: 1, type: 'IfcWall' }];
  useViewerStore.setState(fixtureModels(...Array.from({ length: n }, (_, i) =>
    fixtureModel(i === 0 ? 'model-a' : `model-${i}`, { idOffset: i * 100, entities }))));
}

function compareModel(id: string): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 10,
  } as FederatedModel;
}

function compareRef(modelId: string, localId: number): CompareRef {
  return { modelId, localId, globalId: localId, drawable: false } as CompareRef;
}

function compareResult(modified = 1): CompareResult {
  const entries = Array.from({ length: modified }, (_, i) => ({
    key: `guid-${i + 1}`,
    state: 'modified' as const,
    changeKinds: ['data'],
    base: { key: `guid-${i + 1}`, ifcType: 'IfcWall', ref: compareRef('A', i + 1) },
    head: { key: `guid-${i + 1}`, ifcType: 'IfcWall', ref: compareRef('B', i + 1) },
  }));
  const diff = {
    scope: 'both', excludedTypes: [], entries,
    byKey: new Map(entries.map((e) => [e.key, e])),
    counts: { added: 0, modified, deleted: 0, unchanged: 0 },
  } as unknown as ModelDiff<CompareRef>;
  return { baseModelId: 'A', headModelId: 'B', baseName: 'A.ifc', headName: 'B.ifc', scope: 'both', geometryUnavailable: false, diff } as unknown as CompareResult;
}

function seedCompareModels(n: number): void {
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  useViewerStore.setState({
    models: new Map(ids.map((id) => [id, compareModel(id)])),
    activeModelId: 'A', compareBaseModelId: 'A', compareHeadModelId: 'B',
  });
}

function seedBcf(n: number, topics = 1): void {
  seedIdsModels(n);
  const project = createBCFProject({ name: 'Matrix' });
  for (let i = 0; i < topics; i++) {
    const topic = createBCFTopic({ title: `Topic ${i + 1}`, author: 'a@b.com' });
    project.topics.set(topic.guid, topic);
  }
  useViewerStore.setState({ bcfProject: project, activeTopicId: null });
}

// ── helpers ─────────────────────────────────────────────────────────────────

const buttons = (root: ParentNode = document.body): HTMLButtonElement[] => [...root.querySelectorAll('button')];
const byLabel = (label: string, root?: ParentNode) => buttons(root).find((b) => b.getAttribute('aria-label') === label);
const byText = (text: string, root?: ParentNode) => buttons(root).find((b) => b.textContent?.trim() === text);
const withText = (text: string, root?: ParentNode) => buttons(root).find((b) => b.textContent?.includes(text));

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function clickSettled(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  await act(async () => {
    const until = Date.now() + 10_000;
    while (useViewerStore.getState().clashRunning && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  });
}

/** Mount Clash over `walls` coincident walls and run the real "Detect all". */
async function clashWithResult(n: number, walls = 2): Promise<HTMLElement> {
  await seedCoincidentWalls(n as 1 | 2, walls);
  const ui = render(<ClashPanel />);
  await clickSettled(byText('Detect all clashes', ui)!);
  assert.ok(useViewerStore.getState().clashResult, 'the real detection published a result');
  return ui;
}

function openChooser(): void {
  const chooser = byLabel(resolve('analysisPanel.export.chooseFormat'));
  assert.ok(chooser, 'a split button offers the other formats');
  act(() => {
    chooser.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    chooser.click();
  });
}

async function chooseFormat(label: string): Promise<void> {
  openChooser();
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes(label));
  assert.ok(item, `format "${label}" is listed`);
  await act(async () => { (item as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); });
}

function mountedRows(root: ParentNode): number {
  return root.querySelectorAll('[data-index]').length;
}

afterEach(() => {
  cleanup();
  clearDownloads();
  useViewerStore.setState({
    ...initial,
    models: new Map(), activeModelId: null,
    idsDocument: null, idsValidationReport: null, idsError: null, idsLoading: false, idsProgress: null,
    clashResult: null, clashRawResult: null, clashGroups: null, clashError: null, clashRunning: false, clashProgress: null,
    compareResult: null, compareError: null, compareRunning: false, compareSelectedKey: null, compareBaseModelId: null, compareHeadModelId: null,
    bcfProject: null, activeTopicId: null, bcfError: null, bcfLoading: false,
    isolatedEntities: null, selectedEntityIds: new Set(), selectedEntityId: null,
  });
});

// ── the matrix ──────────────────────────────────────────────────────────────

describe('analysis-panel consistency matrix (#5834)', () => {
  describe('1. run slot: Re-run sits in the header once a result exists', () => {
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      const ui = render(<IDSPanel />);
      assert.equal(byLabel('Re-run validation', ui)?.textContent?.trim(), 'Re-run');
      mark('run slot', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      const ui = await clashWithResult(n);
      assert.equal(byLabel('Re-run detection on the whole model', ui)?.textContent?.trim(), 'Re-run');
      mark('run slot', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      const ui = render(<ComparePanel />);
      assert.equal(byLabel('Re-run the comparison', ui)?.textContent?.trim(), 'Re-run');
      mark('run slot', 'Compare');
    });
    it('BCF: n/a, it runs no analysis, and shows no run slot', () => {
      seedBcf(1);
      const ui = render(<BCFPanel onClose={() => {}} />);
      assert.equal(byText('Re-run', ui), undefined);
      mark('run slot', 'BCF', 'n/a');
    });
  });

  describe('2. re-run repeats the run that produced the result on screen', () => {
    for (const n of counts('IDS')) it(`IDS re-validates the report's model, ${n} model(s)`, () => {
      // The report's model has no parsed data; a re-run of any OTHER model would not say so.
      seedIdsModels(n);
      const models = new Map(useViewerStore.getState().models);
      models.set('model-a', { ...models.get('model-a')!, ifcDataStore: null } as FederatedModel);
      useViewerStore.setState({ models, idsDocument, idsValidationReport: idsReport() });
      render(<IDSPanel />);
      click(byLabel('Re-run validation')!);
      assert.deepEqual(useViewerStore.getState().idsError, { labelKey: 'idsPanel.error.modelNoData' });
      mark('re-run last', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash repeats the last run kind, ${n} model(s)`, async () => {
      await seedCoincidentWalls(n as 1 | 2);
      const ui = render(<ClashPanel />);
      await clickSettled(byText('Find duplicates', ui)!);
      const first = useViewerStore.getState().clashResult;
      await clickSettled(byLabel('Re-run the duplicate scan', ui)!);
      const again = useViewerStore.getState().clashResult;
      assert.ok(again && again !== first, 'a fresh result');
      assert.match(useViewerStore.getState().clashGroups?.[0]?.title ?? '', /coincident/, 'from the duplicate scan again');
      mark('re-run last', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare re-runs the comparison, ${n} models`, () => {
      seedCompareModels(n);
      const report = compareResult();
      useViewerStore.setState({ compareResult: report });
      render(<ComparePanel />);
      click(byLabel('Re-run the comparison')!);
      // The fixture models carry no parsed data, so the real run stops at its first check.
      assert.equal(useViewerStore.getState().compareError, 'Version A is not fully loaded yet.');
      assert.equal(useViewerStore.getState().compareResult, report, 'the result on screen stays');
      mark('re-run last', 'Compare');
    });
    it('BCF: n/a, nothing to re-run', () => { mark('re-run last', 'BCF', 'n/a'); });
  });

  describe('3. the run slot turns into Cancel while a run is in flight, and Cancel stops it', () => {
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport(), idsLoading: true,
        idsProgress: { phase: 'validating', specificationIndex: 0, totalSpecifications: 1, entitiesProcessed: 1, totalEntities: 2, percentage: 50 } });
      render(<IDSPanel />);
      click(byLabel('Cancel validation')!);
      assert.equal(useViewerStore.getState().idsLoading, false);
      mark('cancel', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      const ui = await clashWithResult(n);
      const first = useViewerStore.getState().clashResult;
      act(() => { byLabel('Re-run detection on the whole model', ui)!.click(); });
      const cancel = byLabel('Cancel detection', ui);
      assert.ok(cancel, 'Cancel replaces Re-run while detecting');
      act(() => cancel.click());
      await settle(400);
      assert.equal(useViewerStore.getState().clashRunning, false);
      assert.equal(useViewerStore.getState().clashResult, first, 'the cancelled run published nothing');
      mark('cancel', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult(), compareRunning: true });
      render(<ComparePanel />);
      click(byLabel('Cancel comparison')!);
      assert.equal(useViewerStore.getState().compareRunning, false);
      mark('cancel', 'Compare');
    });
    it('BCF: n/a, nothing runs', () => { mark('cancel', 'BCF', 'n/a'); });
  });

  describe('4. work in flight shows in the one progress component', () => {
    const progressText = (ui: HTMLElement) => ui.querySelector('output')?.textContent ?? '';
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsLoading: true,
        idsProgress: { phase: 'validating', specificationIndex: 0, totalSpecifications: 1, entitiesProcessed: 1, totalEntities: 2, percentage: 50 } });
      assert.match(progressText(render(<IDSPanel />)), /specification/i);
      mark('progress', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ clashRunning: true, clashProgress: { phase: 'narrow', rule: 'all-clashes', done: 3, total: 10 } });
      assert.match(progressText(render(<ClashPanel />)), /3.*10/);
      mark('progress', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareRunning: true });
      assert.equal(progressText(render(<ComparePanel />)).trim(), resolve('comparePanel.panel.comparing'));
      mark('progress', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, ${n} model(s)`, () => {
      seedBcf(n);
      useViewerStore.setState({ bcfLoading: true });
      assert.equal(progressText(render(<BCFPanel onClose={() => {}} />)).trim(), resolve('bcf.panel.busy'));
      mark('progress', 'BCF');
    });
  });

  describe('5. a result the model changed under stays, dimmed, under the stale banner', () => {
    const expectStale = (ui: HTMLElement) => {
      assert.match(ui.querySelector('output')?.textContent ?? '', /model changed/i);
      assert.ok(ui.querySelector('.opacity-60'), 'the old result is dimmed');
    };
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: stampAnalysisReport(idsReport(), captureAnalysisStamp()) });
      const ui = render(<IDSPanel />);
      act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
      expectStale(ui);
      mark('stale', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      const ui = await clashWithResult(n);
      act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
      expectStale(ui);
      mark('stale', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: stampAnalysisReport(compareResult(), captureAnalysisStamp()) });
      const ui = render(<ComparePanel />);
      act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
      expectStale(ui);
      mark('stale', 'Compare');
    });
    it('BCF: n/a, topics are not computed from the model and never go stale', () => {
      seedBcf(1);
      const ui = render(<BCFPanel onClose={() => {}} />);
      act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
      assert.equal(ui.querySelector('output'), null);
      assert.equal(ui.querySelector('.opacity-60'), null);
      mark('stale', 'BCF', 'n/a');
    });
  });

  describe('6. results list in full through the virtualised list (a window mounted, no cap)', () => {
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport(300) });
      const ui = render(<IDSPanel />);
      click(withText('Wall requirements', ui)!);
      const rows = mountedRows(ui);
      assert.ok(rows > 0 && rows < 300, `${rows} of 300 mounted`);
      mark('result list', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      const ui = await clashWithResult(n, 24);
      const total = useViewerStore.getState().clashResult!.summary.total;
      assert.ok(total >= 100, `many clashes (${total})`);
      const rows = mountedRows(ui);
      assert.ok(rows > 0 && rows < total, `${rows} of ${total} mounted`);
      mark('result list', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models, past the old 1000-row cap`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult(1500) });
      const ui = render(<ComparePanel />);
      const rows = mountedRows(ui);
      assert.ok(rows > 0 && rows < 1500, `${rows} of 1500 mounted`);
      assert.doesNotMatch(ui.textContent ?? '', /more not shown/, 'nothing is cut off');
      mark('result list', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, ${n} model(s)`, () => {
      seedBcf(n, 200);
      const ui = render(<BCFPanel onClose={() => {}} />);
      const rows = mountedRows(ui);
      assert.ok(rows > 0 && rows < 200, `${rows} of 200 mounted`);
      mark('result list', 'BCF');
    });
  });

  describe('7. a row click selects what the row is about', () => {
    for (const n of counts('IDS')) it(`IDS selects the entity, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      const ui = render(<IDSPanel />);
      click(withText('Wall requirements', ui)!);
      click(buttons(ui).find((b) => b.getAttribute('aria-label')?.includes('Wall 1'))!);
      assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: 'model-a', expressId: 1 });
      assert.notEqual(useViewerStore.getState().selectedEntityId, null, 'and highlights it');
      mark('row click', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash selects the pair, ${n} model(s)`, async () => {
      const ui = await clashWithResult(n);
      const clash: Clash = useViewerStore.getState().clashResult!.clashes[0];
      click(withText(`${clash.a.tag} × ${clash.b.tag}`, ui)!);
      assert.deepEqual(new Set(useViewerStore.getState().selectedEntityIds), new Set([clash.a.ref, clash.b.ref]));
      mark('row click', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare selects the element, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      const ui = render(<ComparePanel />);
      click(buttons(ui).find((b) => b.textContent?.includes('IfcWall') && b.textContent.includes('data'))!);
      assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [1]);
      assert.equal(useViewerStore.getState().compareSelectedKey, 'guid-1');
      mark('row click', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF opens the topic, ${n} model(s)`, () => {
      seedBcf(n);
      const ui = render(<BCFPanel onClose={() => {}} />);
      click(withText('Topic 1', ui)!);
      const [topic] = useViewerStore.getState().bcfProject!.topics.values();
      assert.equal(useViewerStore.getState().activeTopicId, topic.guid);
      mark('row click', 'BCF');
    });
  });

  describe('8. closing the panel leaves an isolation it did not set', () => {
    const FOREIGN = [5, 105];
    const closeKeeps = (node: ReactNode) => {
      useViewerStore.setState({ isolatedEntities: new Set(FOREIGN) });
      render(node);
      cleanup();
      assert.deepEqual([...useViewerStore.getState().isolatedEntities ?? []], FOREIGN);
    };
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      closeKeeps(<IDSPanel />);
      mark('teardown', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, () => {
      seedIdsModels(n);
      closeKeeps(<ClashPanel />);
      mark('teardown', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      closeKeeps(<ComparePanel />);
      mark('teardown', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, ${n} model(s)`, () => {
      seedBcf(n);
      closeKeeps(<BCFPanel onClose={() => {}} />);
      mark('teardown', 'BCF');
    });
  });

  describe('9. export is one split button: the main button exports, the chevron picks another format', () => {
    const exportButton = (title: string) => {
      const main = byLabel(title);
      assert.ok(main, `export "${title}"`);
      assert.ok(main.querySelector('svg.lucide-download'));
      return main;
    };
    for (const n of counts('IDS')) it(`IDS: HTML, JSON, BCF, ${n} model(s)`, async () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      render(<IDSPanel />);
      exportButton('Export Report (HTML)');
      await chooseFormat('JSON Report');
      assert.ok(downloadedNames().some((name) => name.endsWith('.json')));
      exportButton('Export Report (JSON)');
      mark('export', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash: BCF archive, CSV, ${n} model(s)`, async () => {
      await clashWithResult(n);
      exportButton(resolve('clashTools.export.bcfArchiveTooltip'));
      await chooseFormat('CSV table');
      assert.ok(downloadedNames().some((name) => name.endsWith('.csv')), downloadedNames().join());
      exportButton(resolve('clashTools.export.csvTooltip'));
      mark('export', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare: CSV, JSON, ${n} models`, async () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      render(<ComparePanel />);
      exportButton('Download the change report as CSV');
      await chooseFormat('JSON');
      assert.ok(downloadedNames().some((name) => name.endsWith('.json')), downloadedNames().join());
      exportButton('Download the change report as JSON');
      mark('export', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF: one format, so the main button alone, ${n} model(s)`, async () => {
      seedBcf(n);
      render(<BCFPanel onClose={() => {}} />);
      const main = exportButton('Export BCF');
      assert.equal(byLabel(resolve('analysisPanel.export.chooseFormat')), undefined);
      await act(async () => { main.click(); await new Promise((r) => setTimeout(r, 50)); });
      assert.ok(downloadedNames().some((name) => name.endsWith('.bcfzip')), downloadedNames().join());
      mark('export', 'BCF');
    });
  });

  describe('10. import shows Upload and export shows Download (#5822)', () => {
    const judge = () => {
      let exports = 0;
      for (const button of buttons()) {
        const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`;
        if (/\bexport\b/i.test(name)) {
          exports++;
          assert.equal(button.querySelector('svg.lucide-upload'), null, `${name} shows Upload`);
        }
        if (/\b(import|load)\b/i.test(name)) assert.equal(button.querySelector('svg.lucide-download'), null, `${name} shows Download`);
      }
      assert.ok(exports > 0, 'the panel offers an export');
    };
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      render(<IDSPanel />);
      judge();
      mark('icons', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      await clashWithResult(n);
      judge();
      mark('icons', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      render(<ComparePanel />);
      judge();
      mark('icons', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, ${n} model(s)`, () => {
      seedBcf(n);
      render(<BCFPanel onClose={() => {}} />);
      judge();
      mark('icons', 'BCF');
    });
  });

  describe('11. "Try with demo data" while it would replace nothing of the user\'s', () => {
    const DEMO = 'Try with demo data';
    it('IDS: offered with nothing loaded, not over the user\'s model', () => {
      render(<IDSPanel />);
      assert.ok(byText(DEMO));
      cleanup();
      seedIdsModels(1);
      render(<IDSPanel />);
      assert.equal(byText(DEMO), undefined);
      mark('demo data', 'IDS');
    });
    it('Clash: loads revision B, the demo with an injected clash', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response('ISO-10303-21;')) as typeof fetch;
      const loaded: string[] = [];
      const onLoad = (event: Event) => loaded.push((event as CustomEvent<File>).detail.name);
      window.addEventListener(EVENT_LOAD_FILE, onLoad);
      try {
        render(<ClashPanel />);
        await act(async () => { byText(DEMO)!.click(); await new Promise((r) => setTimeout(r, 20)); });
        assert.deepEqual(loaded, ['building-architecture-rev-b.ifc']);
      } finally {
        window.removeEventListener(EVENT_LOAD_FILE, onLoad);
        globalThis.fetch = originalFetch;
      }
      cleanup();
      await seedCoincidentWalls(2);
      render(<ClashPanel />);
      assert.equal(byText(DEMO), undefined);
      mark('demo data', 'Clash');
    });
    for (const n of [0, 1] as const) it(`Compare: offered below two models only while nothing of the user's is loaded (${n} loaded)`, () => {
      seedCompareModels(n);
      render(<ComparePanel />);
      assert.equal(byText(DEMO) !== undefined, n === 0);
      mark('demo data', 'Compare');
    });
    it('BCF: n/a, the demo kit carries no BCF', () => {
      useViewerStore.setState({ bcfProject: null });
      render(<BCFPanel onClose={() => {}} />);
      assert.equal(byText(DEMO), undefined);
      mark('demo data', 'BCF', 'n/a');
    });
  });

  describe('12. a failure shows in the one error surface under the header', () => {
    const alertText = () => document.body.querySelector('[role="alert"]')?.textContent?.trim();
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsError: { labelKey: 'idsPanel.error.noModelLoaded' } });
      render(<IDSPanel />);
      assert.equal(alertText(), resolve('idsPanel.error.noModelLoaded'));
      mark('error', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ clashError: 'Clash failed' });
      render(<ClashPanel />);
      assert.equal(alertText(), 'Clash failed');
      mark('error', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareError: 'Compare failed' });
      render(<ComparePanel />);
      assert.equal(alertText(), 'Compare failed');
      mark('error', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, dismissable, ${n} model(s)`, () => {
      seedBcf(n);
      useViewerStore.setState({ bcfError: 'BCF failed' });
      render(<BCFPanel onClose={() => {}} />);
      assert.equal(alertText(), 'BCF failed');
      click(byLabel(resolve('analysisPanel.dismissError'))!);
      assert.equal(useViewerStore.getState().bcfError, null);
      mark('error', 'BCF');
    });
  });

  describe('13. Clear results drops the result and keeps the inputs', () => {
    const clear = () => click(byLabel(resolve('analysisPanel.clearResults'))!);
    for (const n of counts('IDS')) it(`IDS keeps the document, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      render(<IDSPanel />);
      clear();
      assert.equal(useViewerStore.getState().idsValidationReport, null);
      assert.equal(useViewerStore.getState().idsDocument, idsDocument);
      mark('clear results', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash keeps the detection settings, ${n} model(s)`, async () => {
      await clashWithResult(n);
      const mode = useViewerStore.getState().clashMode;
      clear();
      assert.equal(useViewerStore.getState().clashResult, null);
      assert.equal(useViewerStore.getState().clashMode, mode);
      mark('clear results', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare keeps the A/B pair, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      render(<ComparePanel />);
      clear();
      const s = useViewerStore.getState();
      assert.equal(s.compareResult, null);
      assert.deepEqual([s.compareBaseModelId, s.compareHeadModelId], ['A', 'B']);
      mark('clear results', 'Compare');
    });
    it('BCF: n/a, topics are the user\'s work, not a computed result', () => {
      seedBcf(1);
      render(<BCFPanel onClose={() => {}} />);
      assert.equal(byLabel(resolve('analysisPanel.clearResults')), undefined);
      mark('clear results', 'BCF', 'n/a');
    });
  });

  describe('14. the result survives leaving and reopening the panel', () => {
    const remount = (node: ReactNode): HTMLElement => {
      render(node);
      cleanup();
      return render(node);
    };
    for (const n of counts('IDS')) it(`IDS, ${n} model(s)`, () => {
      seedIdsModels(n);
      useViewerStore.setState({ idsDocument, idsValidationReport: idsReport() });
      assert.match(remount(<IDSPanel />).textContent ?? '', /Wall requirements/);
      mark('remount', 'IDS');
    });
    for (const n of counts('Clash')) it(`Clash, ${n} model(s)`, async () => {
      await clashWithResult(n);
      const result = useViewerStore.getState().clashResult as ClashResult;
      cleanup();
      const ui = render(<ClashPanel />);
      assert.ok(withText(`${result.clashes[0].a.tag} × ${result.clashes[0].b.tag}`, ui));
      mark('remount', 'Clash');
    });
    for (const n of counts('Compare')) it(`Compare, ${n} models`, () => {
      seedCompareModels(n);
      useViewerStore.setState({ compareResult: compareResult() });
      assert.ok(withText('IfcWall', remount(<ComparePanel />)));
      mark('remount', 'Compare');
    });
    for (const n of counts('BCF')) it(`BCF, ${n} model(s)`, () => {
      seedBcf(n);
      assert.ok(withText('Topic 1', remount(<BCFPanel onClose={() => {}} />)));
      mark('remount', 'BCF');
    });
  });

  after(() => {
    // Read back, not asserted in an `it`: a failing cell above already failed
    // the run; this prints the matrix a reviewer reads.
    const rows = ASPECTS.map((aspect, i) =>
      `${String(i + 1).padStart(2)}. ${aspect.padEnd(14)} ${PANELS.map((p) => (matrix.get(`${aspect}|${p}`) ?? 'MISSING').padEnd(8)).join('')}`);
    console.log(`\n    ${''.padEnd(17)}${PANELS.map((p) => p.padEnd(8)).join('')}\n${rows.map((r) => `    ${r}`).join('\n')}`);
  });

  it('reads 14/14: every aspect holds on every panel', () => {
    const missing = ASPECTS.flatMap((aspect) => PANELS.filter((p) => !matrix.has(`${aspect}|${p}`)).map((p) => `${aspect} / ${p}`));
    assert.deepEqual(missing, []);
    const consistent = ASPECTS.filter((aspect) => PANELS.every((p) => matrix.has(`${aspect}|${p}`)));
    assert.equal(consistent.length, 14);
  });
});
