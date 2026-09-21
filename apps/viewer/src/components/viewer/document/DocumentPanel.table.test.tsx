/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The table block (#5142) end to end in the Document panel over a parsed
 * model: "Add block › Table" seeds a copy of a list, the preview runs it
 * and shows its rows, the export waits for a running list and then prints
 * the table through the seam, and a stale run can never outlive the model
 * it was computed from.
 */
import '@/test/setup-dom.js';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { DEFAULT_THEME, renderChartSvg } from '@ifc-lite/charts';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, click, cleanup } from '@/test/render.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import type { ReportTableArgs } from '@/lib/export/report/generate-report-pdf.js';
import { DOCUMENT_VERSION, type DocumentSpec, type TableBlock } from '@/lib/document/types.js';
import type { TableState } from '@/lib/document/resolve-table.js';
import { DocumentPanel } from './DocumentPanel.js';
import { useDocumentTables } from './useDocumentTables.js';

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Tower',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42,#44),#5);
ENDSEC;
END-ISO-10303-21;
`;

async function parsedModel(): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store: IfcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel('m1', { idOffset: 1_000_000 }), name: 'tower.ifc', ifcDataStore: store, maxExpressId: 91 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

// The hook runs one list per animation frame; frames are captured here and fired on demand, so a
// test can look at the page BEFORE a list has run and then let it run.
const frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
before(() => {
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
});
after(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
});

/** Fire every captured frame (a run schedules the next list's frame as it finishes). */
async function runLists(): Promise<void> {
  for (let guard = 0; frames.length > 0 && guard < 20; guard++) {
    const cb = frames.shift()!;
    await act(async () => { cb(0); });
  }
  await settle();
}

function openMenu(trigger: HTMLElement): void {
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

const wallList = (extra: Partial<ListDefinition> = {}): ListDefinition => ({
  id: 'saved-walls', name: 'Walls by name', createdAt: 1, updatedAt: 1, entityTypes: [IfcTypeEnum.IfcWall], conditions: [],
  columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }, { id: 'storey', source: 'spatial', propertyName: 'Storey' }],
  sortBy: { columnId: 'name', direction: 'desc' },
  ...extra,
});

const tableDoc = (blocks: TableBlock[]): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'doc-t', name: 'Tables', page: { size: 'A4', orientation: 'portrait' }, blocks });
const tableBlock = (id: string, list: ListDefinition, extra: Partial<TableBlock> = {}): TableBlock => ({ kind: 'table', id, source: { kind: 'list', list, fromListId: list.id }, ...extra });

describe('DocumentPanel table block (#5142)', () => {
  beforeEach(async () => {
    const model = await parsedModel();
    useViewerStore.setState({
      models: new Map([[model.id, model]]),
      activeModelId: model.id,
      documents: [],
      activeDocumentId: null,
      dashboards: [],
      bcfProject: null,
      selectedEntityIds: new Set(),
      listDefinitions: [],
      pendingListDraft: null,
      listPanelVisible: false,
    });
  });
  afterEach(() => cleanup());

  it('"Add block › Table" seeds a preset copy without a selection snapshot, and the preview runs it against the model', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    openMenu([...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!);
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Table'))!;
    assert.ok(item, 'the menu offers a table block');
    click(item);
    await settle();

    const doc = useViewerStore.getState().documents[0];
    const block = doc.blocks.find((b): b is TableBlock => b.kind === 'table');
    assert.ok(block, 'a table block was added');
    assert.equal(block.source.list.name, 'Wall Schedule', 'the first preset, with no saved lists');
    assert.equal(block.source.fromListId, 'preset-wall-schedule');
    assert.equal('expressIdsByModel' in block.source.list, false);
    assert.ok(ui.querySelector('[data-block-kind="table"] [data-table-block-editor]'));

    // Before the frame fires the preview says the list is running, and Export waits for it.
    assert.equal(ui.querySelector('[data-block-table] [data-table-message]')?.textContent, 'Running the list…');
    const exportButton = ui.querySelector<HTMLButtonElement>('[data-document-export]')!;
    assert.equal(exportButton.disabled, true);
    assert.equal(exportButton.textContent?.includes('Running lists'), true);

    await runLists();
    const rows = ui.querySelector('[data-block-table] table');
    assert.ok(rows, 'the table rendered');
    const head = [...rows.querySelectorAll('th')].map((th) => th.textContent);
    assert.ok(head.includes('Name') && head.includes('FireRating'), head.join(','));
    const names = [...rows.querySelectorAll('tbody tr[data-role="row"]')].map((tr) => tr.querySelector('td')?.textContent);
    assert.deepEqual(names.sort(), ['Wall A', 'Wall B']);
    assert.equal(exportButton.disabled, false);
  });

  it('prints the table through the seam with the list sorted as saved, and a caption; a second block over the same list shares the run', async () => {
    useViewerStore.setState({ listDefinitions: [wallList()] });
    const doc = tableDoc([tableBlock('t1', wallList(), { caption: 'All walls', maxRows: 1 }), tableBlock('t2', wallList(), { source: { kind: 'list', list: wallList({ id: 'copy-2' }), fromListId: 'saved-walls' } })]);
    useViewerStore.setState({ documents: [doc], activeDocumentId: doc.id });
    const tables: ReportTableArgs[] = [];
    const texts: string[] = [];
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async () => ({
        addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
        text: (t) => { texts.push(t); },
        addImage: () => {},
        svg: async () => {},
        table: (args) => { tables.push(args); },
        pageCount: () => 1,
        output: () => new Blob(['pdf']),
      }),
      renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
      capture: null,
      theme: DEFAULT_THEME,
      now: () => new Date(0),
      imageSize: async () => ({ w: 2, h: 1 }),
    });
    const ui = render(<DocumentPanel pdfSeams={seams} />);
    await settle();
    await runLists();
    const previews = ui.querySelectorAll('[data-block-table] table');
    assert.equal(previews.length, 2, 'both blocks rendered their rows');
    // The saved-list origin resolves, so "Update from saved list" is offered.
    assert.equal(ui.querySelectorAll('[data-table-update]').length, 2);

    click(ui.querySelector('[data-document-export]')!);
    for (let i = 0; i < 20 && tables.length < 2; i++) await settle();
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].head, [['Name', 'Storey']]);
    // sortBy name desc, maxRows 1: Wall B first, then "… 1 more row".
    assert.deepEqual(tables[0].body.map((r) => r[0]), ['Wall B', '… 1 more row']);
    assert.deepEqual(tables[0].rowRoles, ['row', 'more']);
    assert.deepEqual(tables[1].body.map((r) => r[0]), ['Wall B', 'Wall A']);
    assert.ok(texts.includes('All walls'), 'the caption printed');
    assert.ok(texts.includes('Walls by name'), 'the list name is the default title');
  });
});

/** Exposes the hook's states for a document to the DOM. */
function TablesProbe({ document: doc }: { document: DocumentSpec }) {
  const tables = useDocumentTables(doc);
  return <div data-probe>{[...tables].map(([id, s]) => <span key={id} data-block={id} data-status={s.status}>{s.status === 'error' ? s.message : ''}</span>)}</div>;
}

describe('useDocumentTables (#5142)', () => {
  beforeEach(async () => {
    const model = await parsedModel();
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, mutationVersion: 0 });
  });
  afterEach(() => cleanup());

  const statusOf = (ui: HTMLElement, id: string): string | null => ui.querySelector(`[data-block="${id}"]`)?.getAttribute('data-status') ?? null;

  it('resolves after a frame, and a mutation invalidates the result on the very next render — never a stale "ok"', async () => {
    const doc = tableDoc([tableBlock('a', wallList())]);
    const ui = render(<TablesProbe document={doc} />);
    assert.equal(statusOf(ui, 'a'), 'resolving');
    await runLists();
    assert.equal(statusOf(ui, 'a'), 'ok');
    act(() => useViewerStore.setState({ mutationVersion: 1 }));
    assert.equal(statusOf(ui, 'a'), 'resolving', 'the old run is unreachable under the new data key');
    await runLists();
    assert.equal(statusOf(ui, 'a'), 'ok');
  });

  it('a list the engine rejects ends in "error" with its message; no loaded model is "no-model"', async () => {
    const bad = wallList({ columns: [{ id: 'c', source: 'property', psetName: 'Pset_WallCommon', propertyName: '/(a+)+$/' }] });
    const ui = render(<TablesProbe document={tableDoc([tableBlock('bad', bad)])} />);
    await runLists();
    assert.equal(statusOf(ui, 'bad'), 'error');
    assert.ok((ui.querySelector('[data-block="bad"]')?.textContent ?? '').length > 0, 'the message travels with the state');
    cleanup();

    useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null });
    const empty = render(<TablesProbe document={tableDoc([tableBlock('x', wallList())])} />);
    assert.equal(statusOf(empty, 'x'), 'no-model');
  });

  it('two blocks over the same list content share one run; a block whose list differs gets its own', async () => {
    const seen: TableState[] = [];
    function Capture({ document: doc }: { document: DocumentSpec }) {
      const tables = useDocumentTables(doc);
      seen.length = 0;
      seen.push(...tables.values());
      return null;
    }
    const doc = tableDoc([tableBlock('a', wallList()), tableBlock('b', wallList({ id: 'other-id', name: 'Renamed' })), tableBlock('c', wallList({ sortBy: undefined }))]);
    render(<Capture document={doc} />);
    await runLists();
    assert.deepEqual(seen.map((s) => s.status), ['ok', 'ok', 'ok']);
    const models = seen.map((s) => (s.status === 'ok' ? s.model : null));
    assert.equal(models[0], models[1], 'same content (id and name aside) → the same ExportModel object');
    assert.notEqual(models[0], models[2], 'a different sort is a different run');
  });
});

