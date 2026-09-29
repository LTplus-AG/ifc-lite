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
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { cleanup, click, render, waitFor } from '@/test/render';
import { useIDS } from '@/hooks/useIDS';
import { CHECKLIST_VERSION, type ChecklistTemplate } from '@/lib/validation/manual/checklist';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { blankDocument } from '@/lib/document/presets';
import type { DocumentSpec } from '@/lib/document/types';
import { generateDocumentPdf, type DocumentPdfSeams } from '@/lib/document/generate-document-pdf';
import { savedReportBlock, validationReportSnapshot, newSavedReport } from '@/lib/validation/reports/history';
import { loadValidationReports, VALIDATION_REPORTS_STORAGE_KEY } from '@/lib/validation/reports/persistence';
import { DocumentPanel } from '../document/DocumentPanel';
import { ManualValidationTab } from './ManualValidationTab';
import { fixtureModel } from '@/test/store-fixture';
import { SavedValidationReports } from './SavedValidationReports';

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
  useViewerStore.setState({ savedValidationReports: [], validationReportsSaveFailed: false, documents: [], activeDocumentId: null, models: new Map(), dashboards: [], listDefinitions: [], bcfProject: null, idsValidationReport: null, manualChecklist: null });
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
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === 'Saved validation report');
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

describe('saved validation evidence (#6500)', () => {
  it('completed IDS checks automatically retain each real run before the next one replaces the live result', async () => {
    const first = await checkedWall('tower', 'IDS autosave');
    assert.equal(first.source.kind, 'ids');
    if (first.source.kind !== 'ids') assert.fail();
    const bytes = new TextEncoder().encode(WALL_IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer);
    useViewerStore.setState({
      idsDocument: first.source.document,
      models: new Map([['tower', { ...fixtureModel('tower'), name: 'tower.ifc', sourceFingerprint: 'fp-tower', ifcDataStore: store }]]),
      activeModelId: 'tower',
    });
    function RunCheck() {
      const ids = useIDS({ autoApplyColors: false });
      return <button onClick={() => { void ids.runValidation('tower'); }}>Run IDS</button>;
    }
    const ui = render(<RunCheck />);
    const button = ui.querySelector('button'); assert.ok(button);
    click(button);
    await waitFor(() => useViewerStore.getState().savedValidationReports.length === 1, 'first IDS run should enter history');
    click(button);
    await waitFor(() => useViewerStore.getState().savedValidationReports.length === 2, 'a second IDS run should preserve the first');
    const history = loadValidationReports();
    assert.equal(history.length, 2);
    assert.notEqual(history[0].id, history[1].id);
    assert.deepEqual(history.map((entry) => entry.snapshot.reportModels), Array.from({ length: 2 }, () => [{ name: 'tower.ifc', fingerprint: 'fp-tower' }]));
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
    const picker = ui.querySelector('select'); assert.ok(picker);
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
    const picker = ui.querySelector('select'); assert.ok(picker);
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

  it('a refused storage write keeps evidence visible and reports it before reload (#6500)', async () => {
    const snapshot = validationReportSnapshot(await checkedWall('tower', 'Quota check'), new Map(), 'run');
    const write = mock.method(localStorage, 'setItem', () => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    try {
      useViewerStore.getState().saveValidationReport(snapshot);
      const ui = render(<SavedValidationReports />);
      assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /lost on reload/);
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
