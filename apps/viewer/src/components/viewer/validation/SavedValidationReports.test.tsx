/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { createStore } from 'zustand/vanilla';
import { createValidationReportsSlice, type ValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import { SavedReportSource } from '../document/SavedReportSource';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { cleanup, click, render, waitFor } from '@/test/render';
import { useIDS } from '@/hooks/useIDS';
import { CHECKLIST_VERSION, type ChecklistTemplate } from '@/lib/validation/manual/checklist';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { parseDocumentFile } from '@/lib/document/persistence';
import { blankDocument } from '@/lib/document/presets';
import type { DocumentSpec } from '@/lib/document/types';
import { generateDocumentPdf, type DocumentPdfSeams } from '@/lib/document/generate-document-pdf';
import { savedReportBlock, validationReportSnapshot, newSavedReport } from '@/lib/validation/reports/history';
import { loadValidationReports, VALIDATION_REPORTS_STORAGE_KEY } from '@/lib/validation/reports/persistence';
import { DocumentPanel } from '../document/DocumentPanel';
import { ManualValidationTab } from './ManualValidationTab';
import { fixtureModel } from '@/test/store-fixture';
import { SavedValidationReports } from './SavedValidationReports';
import { IDSPanelResults } from '../IDSPanelResults';

const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('scope.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'Tower',$,$,$,$,$,$);
#40=IFCWALL('0Wall000000000000000001',$,'Fire wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function checkedWall(modelId: string, title: string) {
  const bytes = new TextEncoder().encode(WALL_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  const document: IDSDocument = {
    info: { title },
    specifications: [{
      id: 'wall-name', name: 'Wall name present', ifcVersions: ['IFC4'],
      applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
      requirements: [{ id: 'name', optionality: 'required', facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } } }],
    }],
  };
  return validateIDS(document, createDataAccessor(store, modelId), { modelId, schemaVersion: 'IFC4', entityCount: store.entityCount }, { includePassingEntities: true });
}

const initial = useViewerStore.getState();
beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({ savedValidationReports: [], validationReportsSaveFailed: false, validationReportsLoadIssue: null, documents: [], activeDocumentId: null, models: new Map(), dashboards: [], listDefinitions: [], bcfProject: null, idsValidationReport: null, currentValidationReport: null, idsLoading: false, manualChecklist: null });
});
afterEach(() => { cleanup(); useViewerStore.setState(initial); });

function select(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

async function settle() { await act(async () => { await Promise.resolve(); }); }

function openAddMenu(ui: HTMLElement) {
  const trigger = [...ui.querySelectorAll('button')].find((button) => button.title === 'Add a block to the page');
  assert.ok(trigger);
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  click(trigger);
}

function addSavedBlock(ui: HTMLElement) {
  openAddMenu(ui);
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === 'Validation report');
  assert.ok(item);
  click(item);
}

async function printedPdf(document: DocumentSpec): Promise<string[]> {
  const printed: string[] = [];
  const seams: DocumentPdfSeams = {
    createDoc: async () => ({ addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {}, fillRect: () => {}, text: (text) => { printed.push(text); }, addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']) }),
    renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }),
  };
  await generateDocumentPdf({ document: document, bindings: { models: [], activeModelId: null, today: new Date(0) }, aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), tables: new Map() }, seams);
  return printed;
}

function RunCheck() {
  const ids = useIDS({ autoApplyColors: false });
  return <>
    <button onClick={() => { void ids.runValidation('tower'); }}>Run IDS</button>
    <IDSPanelResults results={ids} runValidation={ids.runValidation} validating={ids.loading} onEntityClick={() => {}} />
  </>;
}

const reportButton = (ui: HTMLElement, name: string) => {
  const button = [...ui.querySelectorAll('button')].find((candidate) => candidate.textContent === name);
  assert.ok(button, `expected ${name}`);
  return button;
};

async function seedRun() {
  const first = await checkedWall('tower', 'Explicit IDS save');
  assert.equal(first.source.kind, 'ids');
  if (first.source.kind !== 'ids') assert.fail();
  const bytes = new TextEncoder().encode(WALL_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  useViewerStore.setState({ idsDocument: first.source.document,
    models: new Map([['tower', { ...fixtureModel('tower'), name: 'tower.ifc', sourceFingerprint: 'fp-tower', ifcDataStore: store }]]), activeModelId: 'tower' });
}

describe('saved validation evidence (#6500)', () => {
  it('only explicitly saves a completed real IDS run, once, with its completion-time provenance (#6568)', async () => {
    await seedRun();
    let ui = render(<RunCheck />);
    click(reportButton(ui, 'Run IDS'));
    await waitFor(() => useViewerStore.getState().idsValidationReport !== null, 'first IDS run should show results');
    assert.equal(useViewerStore.getState().savedValidationReports.length, 0);
    assert.equal(localStorage.getItem(VALIDATION_REPORTS_STORAGE_KEY), null, 'checking alone writes no report history');
    const first = useViewerStore.getState().idsValidationReport!;
    // Closing/reopening the panel and renaming a model must not lose or alter
    // the evidence captured when the check finished.
    cleanup();
    act(() => useViewerStore.setState({ models: new Map([['tower', { ...useViewerStore.getState().models.get('tower')!, name: 'renamed.ifc', sourceFingerprint: 'fp-later' }]]) }));
    first.specificationResults[0].passedCount = 0;
    ui = render(<RunCheck />);
    const save = reportButton(ui, 'Save report');
    click(save);
    click(save);
    assert.equal(reportButton(ui, 'Report saved').disabled, true);
    assert.equal(loadValidationReports().length, 1, 'rapid repeat clicks keep one saved entry');
    const original = loadValidationReports()[0].snapshot;
    assert.equal(original.kind, 'ids-report');
    if (original.kind !== 'ids-report') assert.fail();
    assert.equal(original.summary.passed, 1, 'saved evidence retains the original result');
    click(reportButton(ui, 'Run IDS'));
    await waitFor(() => useViewerStore.getState().idsValidationReport !== first, 'second IDS run replaces the live result');
    assert.equal(loadValidationReports().length, 1, 'a later check does not automatically add another report');
    click(reportButton(ui, 'Save report'));
    const history = loadValidationReports();
    assert.equal(history.length, 2);
    assert.notEqual(history[0].id, history[1].id);
    assert.deepEqual(history.map((entry) => entry.snapshot.reportModels), [
      [{ name: 'tower.ifc', fingerprint: 'fp-tower' }], [{ name: 'renamed.ifc', fingerprint: 'fp-later' }],
    ]);
  });

  it('an explicit save reports a real storage refusal and retries the same evidence without a duplicate (#6568)', async () => {
    await seedRun();
    const ui = render(<RunCheck />);
    click(reportButton(ui, 'Run IDS'));
    await waitFor(() => useViewerStore.getState().idsValidationReport !== null, 'IDS run should finish');
    const write = mock.method(localStorage, 'setItem', () => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    try {
      click(reportButton(ui, 'Save report'));
      assert.equal(reportButton(ui, 'Save pending').disabled, true);
      assert.equal(useViewerStore.getState().savedValidationReports.length, 1);
      assert.equal(loadValidationReports().length, 0);
      assert.ok([...ui.querySelectorAll('[role="alert"]')].some((alert) => /storage|lost on reload/.test(alert.textContent ?? '')));
    } finally { write.mock.restore(); }
    click(reportButton(ui, 'Retry save'));
    assert.equal(reportButton(ui, 'Report saved').disabled, true);
    assert.equal(loadValidationReports().length, 1);
    assert.deepEqual(loadValidationReports()[0].snapshot.reportModels, [{ name: 'tower.ifc', fingerprint: 'fp-tower' }]);
  });

  it('captures meaningful scope for unnamed actual IDS models and refuses blank stored scope (#6500 review)', async () => {
    const report = await checkedWall('tower', 'Name boundary');
    for (const name of ['', '   ']) {
      const snapshot = validationReportSnapshot(report, new Map([['tower', { name, sourceFingerprint: '' }]]), 'run');
      assert.deepEqual(snapshot.reportModels, [{ name: 'tower' }]);
      useViewerStore.getState().saveValidationReport(snapshot);
      const document = { ...blankDocument(), blocks: [savedReportBlock(loadValidationReports().at(-1)!, 'b')] };
      assert.ok((await printedPdf(document)).includes('Models: tower'));
    }
    const exact = validationReportSnapshot(await checkedWall('tower', 'Exact original name'), new Map([['tower', { name: '  original model.ifc  ', sourceFingerprint: 'fp-tower' }]]), 'run');
    assert.deepEqual(exact.reportModels, [{ name: '  original model.ifc  ', fingerprint: 'fp-tower' }]);
    const valid = newSavedReport(exact);
    for (const name of ['', '   ']) {
      const invalid = newSavedReport({ ...exact, reportModels: [{ name }] });
      localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, JSON.stringify([invalid, valid]));
      assert.deepEqual(loadValidationReports().map((entry) => entry.id), [valid.id]);
      assert.throws(() => parseDocumentFile(JSON.stringify({ ...blankDocument(), blocks: [invalid.snapshot] })), /expected non-empty model names/);
    }
    useViewerStore.setState({ models: new Map([['tower', { ...fixtureModel('tower'), name: '   ', sourceFingerprint: 'fp-tower' }]]), activeModelId: 'tower', manualChecklist: { version: CHECKLIST_VERSION, name: 'Unnamed source review', groups: [] } });
    const ui = render(<ManualValidationTab manual={{ checklist: useViewerStore.getState().manualChecklist, recent: [], error: null, newChecklist: () => {}, save: () => {}, close: () => {}, loadFromRecent: () => {}, openFromFile: async () => ({ ok: true }) }} />);
    const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save report'); assert.ok(save);
    click(save);
    const manual = loadValidationReports().at(-1)!;
    assert.deepEqual(manual.snapshot.reportModels, [{ name: 'tower', fingerprint: 'fp-tower' }]);
    assert.equal(manual.snapshot.kind, 'manual-report');
    if (manual.snapshot.kind !== 'manual-report') assert.fail();
    assert.equal(manual.snapshot.modelName, 'tower');
  });

  it('persists distinct real IFC runs and their exact evaluated scope, independent of later live runs', async () => {
    const first = await checkedWall('tower', 'Architecture IDS');
    const second = await checkedWall('structure', 'Structure IDS');
    const models = new Map([
      ['tower', { name: 'tower.ifc', sourceFingerprint: 'fp-tower' }],
      ['structure', { name: 'structure.ifc', sourceFingerprint: 'fp-structure' }],
      ['unrelated', { name: 'unrelated.ifc', sourceFingerprint: 'fp-other' }],
    ]);
    useViewerStore.getState().saveValidationReport(validationReportSnapshot(first, models, 'a'));
    useViewerStore.getState().saveValidationReport(validationReportSnapshot(second, models, 'b'));
    const restored = loadValidationReports();
    assert.equal(restored.length, 2);
    assert.deepEqual(restored.map((entry) => entry.snapshot.reportModels), [[{ name: 'tower.ifc', fingerprint: 'fp-tower' }], [{ name: 'structure.ifc', fingerprint: 'fp-structure' }]]);
    assert.equal(restored[0].snapshot.kind, 'ids-report');
    if (restored[0].snapshot.kind !== 'ids-report') assert.fail();
    assert.equal(restored[0].snapshot.summary.checked, 1);
    assert.equal(restored[0].snapshot.summary.passed, 1);
    first.specificationResults[0].passedCount = 0;
    useViewerStore.getState().clearAllModels();
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearIdsValidationReport();
    const ui = render(<SavedValidationReports />);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Select saved validation report"]'); assert.ok(picker);
    select(picker, restored[0].id);
    assert.match(ui.textContent ?? '', /Architecture IDS/);
    assert.match(ui.textContent ?? '', /Models: tower.ifc/);
    assert.doesNotMatch(ui.querySelector('[data-report-model-scope]')?.textContent ?? '', /structure|unrelated/);
    assert.equal(useViewerStore.getState().savedValidationReports.length, 2);
  });

  it('selects two saved checks in documents and prints frozen evidence after history deletion', async () => {
    for (const [modelId, name] of [['tower', 'First check'], ['structure', 'Second check']]) {
      const report = await checkedWall(modelId, name);
      useViewerStore.getState().saveValidationReport(validationReportSnapshot(report, new Map([[modelId, { name: `${modelId}.ifc` }]]), 'run'));
    }
    const reports = useViewerStore.getState().savedValidationReports;
    const document = blankDocument();
    document.blocks = [];
    useViewerStore.getState().upsertDocument(document);
    useViewerStore.getState().setActiveDocumentId(document.id);
    const ui = render(<DocumentPanel />); await settle();
    addSavedBlock(ui); await settle();
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]'); assert.ok(picker);
    assert.ok(picker.querySelector<HTMLOptionElement>('option[value=""]')?.disabled, 'retained snapshot placeholder cannot trigger a no-op selection');
    select(picker, reports[0].id); await settle();
    assert.match(ui.querySelector('[data-block-ids-report]')?.textContent ?? '', /First check/);
    addSavedBlock(ui); await settle();
    const doc = useViewerStore.getState().documents[0];
    assert.equal(doc.blocks.length, 2);
    act(() => { for (const entry of reports) useViewerStore.getState().removeValidationReport(entry.id); });
    const printed = await printedPdf(doc);
    assert.ok(printed.includes('IDS report: First check'));
    assert.ok(printed.includes('IDS report: Second check'));
    assert.ok(printed.includes('Models: tower.ifc'));
    assert.ok(printed.includes('Models: structure.ifc'));
    assert.equal(loadValidationReports().length, 0);
  });

  it('keeps compact/long presentation editable for frozen IDS sources without live refresh (#6500)', async () => {
    for (const name of ['First issued check', 'Second issued check']) {
      const report = await checkedWall('tower', name);
      report.specificationResults[0].specification.description = 'Authored long guidance';
      useViewerStore.getState().saveValidationReport(validationReportSnapshot(report, new Map([['tower', { name: 'tower.ifc' }]]), 'run'));
    }
    const reports = useViewerStore.getState().savedValidationReports;
    const document = { ...blankDocument(), blocks: [] };
    useViewerStore.getState().upsertDocument(document);
    useViewerStore.getState().setActiveDocumentId(document.id);
    const ui = render(<DocumentPanel />); await settle();
    addSavedBlock(ui); await settle();
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]'); assert.ok(picker);
    const layout = ui.querySelector<HTMLSelectElement>('select[aria-label="IDS report layout"]'); assert.ok(layout);
    assert.equal([...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Refresh from current validation report')), false, 'frozen evidence has no live refresh');
    const originalId = useViewerStore.getState().documents[0].blocks[0].id;
    assert.equal(layout.value, '', 'existing snapshots retain the original layout');
    assert.ok((await printedPdf(useViewerStore.getState().documents[0])).includes('Authored long guidance'));
    select(layout, 'compact'); await settle();
    assert.ok(ui.querySelector('[data-ids-report-variant="compact"]'));
    select(picker, reports[0].id); await settle();
    assert.equal(layout.value, 'compact', 'changing frozen IDS source retains presentation');
    assert.ok(ui.querySelector('[data-ids-report-variant="compact"]'));
    select(layout, 'long'); await settle();
    assert.match(ui.querySelector('[data-block-ids-report]')?.textContent ?? '', /Authored long guidance/);
    act(() => { for (const entry of reports) useViewerStore.getState().removeValidationReport(entry.id); });
    const retained = useViewerStore.getState().documents[0];
    assert.equal(retained.blocks[0].id, originalId);
    assert.ok((await printedPdf(retained)).includes('Authored long guidance'));
    select(layout, 'compact'); await settle();
    const compactPrinted = await printedPdf(useViewerStore.getState().documents[0]);
    assert.ok(compactPrinted.includes('Wall name present'));
    assert.equal(compactPrinted.includes('Authored long guidance'), false);
  });

  for (const latestKind of ['ids-report', 'manual-report'] as const) {
    it(`selects an older saved report of another kind when latest is ${latestKind}, with no live source (#6500)`, async () => {
      const ids = validationReportSnapshot(await checkedWall('tower', 'Archived IDS'), new Map([['tower', { name: 'tower.ifc' }]]), 'ids');
      const manual = {
        ...manualReportBlockFromChecklist({
          checklist: { version: CHECKLIST_VERSION, name: 'Mechanical review', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'i', text: 'Fire stop reviewed' }] }] },
          answers: { i: { status: 'warning', comment: 'Confirm fire stop', updatedAt: 1 } }, modelName: 'structure.ifc',
        }, 'manual'),
        reportModels: [{ name: 'structure.ifc' }],
      };
      const order = latestKind === 'ids-report' ? [manual, ids] : [ids, manual];
      for (const snapshot of order) useViewerStore.getState().saveValidationReport(snapshot);
      const reports = useViewerStore.getState().savedValidationReports;
      const document = { ...blankDocument(), blocks: [] };
      useViewerStore.getState().upsertDocument(document);
      useViewerStore.getState().setActiveDocumentId(document.id);
      assert.equal(useViewerStore.getState().models.size, 0);
      assert.equal(useViewerStore.getState().idsValidationReport, null);
      assert.equal(useViewerStore.getState().manualChecklist, null);
      const ui = render(<DocumentPanel />); await settle();
      addSavedBlock(ui); await settle();
      const blockId = useViewerStore.getState().documents[0].blocks[0].id;
      const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved report source"]'); assert.ok(picker);
      select(picker, reports[0].id); await settle();
      const chosen = useViewerStore.getState().documents[0].blocks[0];
      assert.equal(chosen.id, blockId, 'changing report kind preserves document block identity');
      assert.equal(chosen.kind, order[0].kind);
      addSavedBlock(ui); await settle();
      assert.ok(ui.querySelector('[data-block-ids-report]'));
      assert.ok(ui.querySelector('[data-block-manual-report]'));
      act(() => { for (const entry of reports) useViewerStore.getState().removeValidationReport(entry.id); });
      const printed = await printedPdf(useViewerStore.getState().documents[0]);
      for (const evidence of ['IDS report: Archived IDS', 'Manual validation: Mechanical review', 'Models: tower.ifc', 'Models: structure.ifc', 'WARNING', 'Comment: Confirm fire stop']) assert.ok(printed.includes(evidence), `embedded PDF retains ${evidence}`);
    });
  }

  it('keeps manual round verdicts and comments frozen when a later round changes answers', () => {
    const checklist: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Discipline check', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'i', text: 'Placed correctly' }] }] };
    const first = newSavedReport(manualReportBlockFromChecklist({ checklist, answers: { i: { status: 'warning', comment: 'Review origin', updatedAt: 1 } }, modelName: 'tower.ifc', modelFingerprint: 'fp-tower' }, 'manual-a'));
    const second = newSavedReport(manualReportBlockFromChecklist({ checklist, answers: { i: { status: 'pass', updatedAt: 2 } }, modelName: 'tower.ifc', modelFingerprint: 'fp-tower' }, 'manual-b'));
    const document = blankDocument();
    document.blocks = [savedReportBlock(first, 'b1'), savedReportBlock(second, 'b2')];
    const firstBlock = document.blocks[0];
    assert.equal(firstBlock.kind, 'manual-report');
    if (firstBlock.kind !== 'manual-report') assert.fail();
    if (first.snapshot.kind === 'manual-report') first.snapshot.groups[0].items[0].status = 'fail';
    assert.equal(firstBlock.groups[0].items[0].status, 'warning');
    assert.equal(firstBlock.groups[0].items[0].comment, 'Review origin');
  });

  for (const loaded of [false, true]) {
    it(`saves valid manual evidence when a ${loaded ? 'loaded model has no source fingerprint' : 'checklist has no loaded model'} (#6500 review)`, () => {
      const checklist: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Unanswered review', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'i', text: 'Origin approved' }] }] };
      const model = { ...fixtureModel('unnamed'), name: 'unidentified.ifc', sourceFingerprint: null };
      useViewerStore.setState({ models: loaded ? new Map([[model.id, model]]) : new Map(), activeModelId: loaded ? model.id : null, manualChecklist: checklist, manualAnswers: {} });
      const ui = render(<ManualValidationTab manual={{ checklist, recent: [], error: null, newChecklist: () => {}, save: () => {}, close: () => {}, loadFromRecent: () => {}, openFromFile: async () => ({ ok: true }) }} />);
      const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save report'); assert.ok(save);
      click(save);
      const saved = loadValidationReports();
      assert.equal(saved.length, 1, 'actual Save persists a validator-accepted snapshot');
      assert.equal(saved[0].snapshot.kind, 'manual-report');
      if (saved[0].snapshot.kind !== 'manual-report') assert.fail();
      assert.equal('modelFingerprint' in saved[0].snapshot, false, 'null source identity is omitted, never serialized');
      assert.deepEqual(saved[0].snapshot.reportModels, loaded ? [{ name: 'unidentified.ifc' }] : []);
      assert.equal(saved[0].snapshot.summary.unanswered, 1);
    });
  }

  it('live IDS Add and Refresh retain evaluated scope after current models change (#6500)', async () => {
    const first = await checkedWall('tower', 'Evaluated first');
    const ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(WALL_IFC).buffer);
    const scope = new Map([['tower', { name: 'original-tower.ifc', sourceFingerprint: 'original-source' }]]);
    const firstSnapshot = validationReportSnapshot(first, scope, 'run');
    scope.get('tower')!.name = 'renamed-later.ifc';
    firstSnapshot.reportModels![0].name = 'edited history copy';
    useViewerStore.setState({ idsValidationReport: first, models: new Map([['tower', { ...fixtureModel('tower'), ifcDataStore, name: 'replacement.ifc', sourceFingerprint: 'replacement-source' }]]) });
    const document = { ...blankDocument(), blocks: [] };
    useViewerStore.getState().upsertDocument(document);
    useViewerStore.getState().setActiveDocumentId(document.id);
    const ui = render(<DocumentPanel />); await settle();
    openAddMenu(ui);
    const add = [...globalThis.document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === 'Validation report'); assert.ok(add);
    click(add); await settle();
    assert.match(ui.querySelector('[data-report-model-scope]')?.textContent ?? '', /original-tower.ifc/);
    assert.doesNotMatch(ui.querySelector('[data-report-model-scope]')?.textContent ?? '', /replacement|renamed|edited/);
    const second = await checkedWall('tower', 'Evaluated second');
    validationReportSnapshot(second, new Map([['tower', { name: 'second-tower.ifc', sourceFingerprint: 'second-source' }]]), 'run');
    act(() => useViewerStore.setState({ idsValidationReport: second, models: new Map() }));
    const refresh = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Refresh from current validation report'); assert.ok(refresh);
    click(refresh); await settle();
    assert.match(ui.querySelector('[data-report-model-scope]')?.textContent ?? '', /second-tower.ifc/);
    const current = useViewerStore.getState().documents[0];
    assert.deepEqual(current.blocks[0].kind === 'ids-report' && current.blocks[0].reportModels, [{ name: 'second-tower.ifc', fingerprint: 'second-source' }]);
    assert.ok((await printedPdf(current)).includes('Models: second-tower.ifc'));
  });

  it('the manual save button snapshots the explicitly picked model in a federation (#6500)', () => {
    const checklist: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Discipline review', groups: [{ id: 'g', name: 'Checks', items: [{ id: 'i', text: 'Correct origin' }] }] };
    useViewerStore.setState({
      models: new Map([
        ['tower', { ...fixtureModel('tower'), name: 'tower.ifc', sourceFingerprint: 'fp-tower' }],
        ['structure', { ...fixtureModel('structure'), name: 'structure.ifc', sourceFingerprint: 'fp-structure' }],
      ]),
      activeModelId: 'tower', manualChecklist: checklist,
      manualAnswers: { 'fp-tower': { i: { status: 'fail', updatedAt: 1 } }, 'fp-structure': { i: { status: 'warning', comment: 'Confirm survey', updatedAt: 1 } } },
    });
    const ui = render(<ManualValidationTab manual={{ checklist, recent: [], error: null, newChecklist: () => {}, save: () => {}, close: () => {}, loadFromRecent: () => {}, openFromFile: async () => ({ ok: true }) }} />);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Model"]'); assert.ok(picker);
    select(picker, 'structure');
    const button = [...ui.querySelectorAll('button')].find((element) => element.textContent === 'Save report'); assert.ok(button);
    click(button);
    const report = loadValidationReports()[0];
    assert.equal(report.snapshot.kind, 'manual-report');
    if (report.snapshot.kind !== 'manual-report') assert.fail();
    assert.equal(report.snapshot.modelFingerprint, 'fp-structure');
    assert.equal(report.snapshot.summary.warning, 1);
    assert.equal(report.snapshot.summary.fail, 0);
    assert.equal(report.snapshot.groups[0].items[0].comment, 'Confirm survey');
    assert.deepEqual(report.snapshot.reportModels, [{ name: 'structure.ifc', fingerprint: 'fp-structure' }]);
  });

  for (const malformed of ['invalid JSON', 'non-array', 'partial and duplicate'] as const) {
    it(`reports ${malformed} history in library and source chooser while preserving original bytes (#6500)`, async () => {
      const valid = newSavedReport(validationReportSnapshot(await checkedWall('tower', 'Valid neighbor'), new Map(), 'run'));
      const raw = malformed === 'invalid JSON' ? '{broken' : malformed === 'non-array' ? JSON.stringify({ report: valid }) : JSON.stringify([valid, { id: 'broken' }, valid]);
      localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, raw);
      const loaded = createStore<ValidationReportsSlice>()(createValidationReportsSlice).getState();
      useViewerStore.setState({ savedValidationReports: loaded.savedValidationReports, validationReportsLoadIssue: loaded.validationReportsLoadIssue });
      const library = render(<SavedValidationReports />);
      assert.match(library.querySelector('[role="alert"]')?.textContent ?? '', /some entries could not be read|Saving is blocked/);
      assert.equal(loaded.savedValidationReports.length, malformed === 'partial and duplicate' ? 1 : 0);
      cleanup();
      const source = render(<SavedReportSource block={valid.snapshot} onChange={() => {}} />);
      assert.match(source.querySelector('[role="alert"]')?.textContent ?? '', /original data was preserved/);
      assert.equal(localStorage.getItem(`${VALIDATION_REPORTS_STORAGE_KEY}:unreadable`), raw, 'complete original survives byte-for-byte');
      assert.deepEqual(loadValidationReports().map((entry) => entry.id), malformed === 'partial and duplicate' ? [valid.id] : []);
      act(() => useViewerStore.getState().saveValidationReport(valid.snapshot, 'New check'));
      assert.equal(localStorage.getItem(`${VALIDATION_REPORTS_STORAGE_KEY}:unreadable`), raw, 'later save never destroys preserved evidence');
      assert.ok(loadValidationReports().some((entry) => entry.name === 'New check'));
    });
  }

  it('publishes newly recovered external corruption through both live history consumers (#6500)', async () => {
    const valid = newSavedReport(validationReportSnapshot(await checkedWall('tower', 'Original in-memory evidence'), new Map(), 'run'));
    localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, JSON.stringify([valid]));
    const loaded = createStore<ValidationReportsSlice>()(createValidationReportsSlice).getState();
    useViewerStore.setState({ savedValidationReports: loaded.savedValidationReports, validationReportsLoadIssue: loaded.validationReportsLoadIssue });
    const ui = render(<><SavedValidationReports /><SavedReportSource block={valid.snapshot} onChange={() => {}} /></>);
    assert.equal(ui.querySelectorAll('[role="alert"]').length, 0);
    const damaged = '{external corruption';
    localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, damaged);
    act(() => useViewerStore.getState().saveValidationReport(valid.snapshot, 'Later check'));
    assert.equal(useViewerStore.getState().validationReportsLoadIssue, 'recovered');
    assert.equal(ui.querySelectorAll('[data-saved-history-issue="recovered"]').length, 2);
    assert.equal(localStorage.getItem(`${VALIDATION_REPORTS_STORAGE_KEY}:unreadable`), damaged);
    assert.deepEqual(loadValidationReports().map((entry) => entry.name), ['Original in-memory evidence', 'Later check']);
    act(() => useViewerStore.getState().retryValidationReportsSave());
    assert.equal(ui.querySelectorAll('[role="alert"]').length, 0, 'healthy retry clears prior recovery notices');
  });

  for (const partial of [false, true]) {
    it(`retains unknown stored neighbors after an unavailable read and respects later deletion during ${partial ? 'blocked backup' : 'write quota'} (#6500)`, async () => {
      const valid = newSavedReport(validationReportSnapshot(await checkedWall('tower', 'Unknown stored neighbor'), new Map(), 'run'));
      const raw = JSON.stringify(partial ? [valid, { id: 'damaged' }] : [valid]);
      localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, raw);
      const actualGet = localStorage.getItem.bind(localStorage);
      const inaccessible = mock.method(localStorage, 'getItem', (key: string) => {
        if (key === VALIDATION_REPORTS_STORAGE_KEY) throw new DOMException('Read blocked', 'SecurityError');
        return actualGet(key);
      });
      let library: HTMLElement;
      try {
        const loaded = createStore<ValidationReportsSlice>()(createValidationReportsSlice).getState();
        useViewerStore.setState({ savedValidationReports: loaded.savedValidationReports, validationReportsLoadIssue: loaded.validationReportsLoadIssue });
        library = render(<SavedValidationReports />);
        assert.match(library.querySelector('[role="alert"]')?.textContent ?? '', /could not be read or updated/);
        act(() => useViewerStore.getState().saveValidationReport(valid.snapshot, 'Pending in-memory check'));
      } finally { inaccessible.mock.restore(); }
      const actualSet = localStorage.setItem.bind(localStorage);
      const quota = mock.method(localStorage, 'setItem', (key: string, value: string) => {
        if (partial ? key.includes(':unreadable') : key === VALIDATION_REPORTS_STORAGE_KEY) throw new DOMException('Storage full', 'QuotaExceededError');
        actualSet(key, value);
      });
      const retry = () => {
        const button = [...library.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Retry save'); assert.ok(button);
        click(button);
      };
      try {
        retry();
        assert.deepEqual(useViewerStore.getState().savedValidationReports.map((entry) => entry.name), ['Unknown stored neighbor', 'Pending in-memory check'], 'failed write still publishes discovered neighbors');
        const picker = library.querySelector<HTMLSelectElement>('select[aria-label="Select saved validation report"]'); assert.ok(picker);
        select(picker, valid.id);
        const remove = [...library.querySelectorAll('button')].find((button) => button.textContent === 'Remove report'); assert.ok(remove);
        click(remove);
        assert.deepEqual(useViewerStore.getState().savedValidationReports.map((entry) => entry.name), ['Pending in-memory check']);
        assert.equal(localStorage.getItem(VALIDATION_REPORTS_STORAGE_KEY), raw, 'failed writes leave original bytes intact');
      } finally { quota.mock.restore(); }
      retry();
      assert.deepEqual(loadValidationReports().map((entry) => entry.name), ['Pending in-memory check'], 'healthy retry never resurrects the explicitly removed known neighbor');
      assert.equal(useViewerStore.getState().validationReportsSaveFailed, false);
      if (partial) assert.equal(localStorage.getItem(`${VALIDATION_REPORTS_STORAGE_KEY}:unreadable`), raw);
    });
  }

  it('refuses a later save when quota prevents archiving damaged validation history, then safely retries (#6500)', async () => {
    const valid = newSavedReport(validationReportSnapshot(await checkedWall('tower', 'Quota neighbor'), new Map(), 'run'));
    const raw = JSON.stringify([valid, { id: 'broken' }]);
    localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, raw);
    const actualSet = localStorage.setItem.bind(localStorage);
    const blocked = mock.method(localStorage, 'setItem', (key: string, value: string) => {
      if (key.includes(':unreadable')) throw new DOMException('Storage full', 'QuotaExceededError');
      actualSet(key, value);
    });
    try {
      const loaded = createStore<ValidationReportsSlice>()(createValidationReportsSlice).getState();
      useViewerStore.setState({ savedValidationReports: loaded.savedValidationReports, validationReportsLoadIssue: loaded.validationReportsLoadIssue });
      const library = render(<SavedValidationReports />);
      assert.match(library.querySelector('[role="alert"]')?.textContent ?? '', /some entries could not be read|Saving is blocked/);
      act(() => useViewerStore.getState().saveValidationReport(valid.snapshot, 'Pending check'));
      assert.equal(localStorage.getItem(VALIDATION_REPORTS_STORAGE_KEY), raw, 'unarchived original cannot be overwritten');
      assert.ok(useViewerStore.getState().validationReportsSaveFailed);
      assert.ok(library.textContent?.includes('storage refused the save'));
    } finally { blocked.mock.restore(); }
    const retry = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Retry save'); assert.ok(retry);
    click(retry);
    assert.equal(useViewerStore.getState().validationReportsLoadIssue, 'recovered');
    assert.equal(useViewerStore.getState().validationReportsSaveFailed, false);
    act(() => useViewerStore.getState().renameValidationReport(useViewerStore.getState().savedValidationReports.at(-1)!.id, 'Recovered check'));
    assert.equal(useViewerStore.getState().validationReportsLoadIssue, null, 'healthy write clears stale recovery status');
    assert.equal(localStorage.getItem(`${VALIDATION_REPORTS_STORAGE_KEY}:unreadable`), raw);
    assert.ok(loadValidationReports().some((entry) => entry.name === 'Recovered check'));
  });

  it('a refused storage write keeps evidence visible and reports it before reload (#6500)', async () => {
    const snapshot = validationReportSnapshot(await checkedWall('tower', 'Quota check'), new Map(), 'run');
    const write = mock.method(localStorage, 'setItem', () => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    try {
      useViewerStore.getState().saveValidationReport(snapshot);
      const ui = render(<SavedValidationReports />);
      assert.ok([...ui.querySelectorAll('[role="alert"]')].some((alert) => /lost on reload/.test(alert.textContent ?? '')), 'quota failure explicitly warns that unsaved evidence is lost on reload');
      assert.match(ui.textContent ?? '', /Quota check/);
      assert.equal(loadValidationReports().length, 0);
    } finally { write.mock.restore(); }
  });

  it('rejects malformed stored scope and duplicate ids without losing valid evidence', async () => {
    const valid = newSavedReport(validationReportSnapshot(await checkedWall('tower', 'Keep'), new Map(), 'run'));
    const broken = { ...valid, id: 'bad', snapshot: { ...valid.snapshot, reportModels: [{ name: 7 }] } };
    localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, JSON.stringify([broken, valid, valid]));
    assert.deepEqual(loadValidationReports().map((entry) => entry.id), [valid.id]);
  });
});
