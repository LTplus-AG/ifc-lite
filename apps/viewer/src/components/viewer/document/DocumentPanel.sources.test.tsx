/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { DEFAULT_THEME } from '@ifc-lite/charts';
import { useViewerStore, type FederatedModel } from '@/store/index.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, cleanup, click, type } from '@/test/render.js';
import { modelBindingPath } from '@/lib/document/binding-path.js';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence.js';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import { DocumentPanel } from './DocumentPanel.js';

async function parsedModel(id: string, name: string, project: string, rating: string): Promise<FederatedModel> {
  const source = `ISO-10303-21;
HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('t','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'${project}',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Duplicate level',$,$,$,$,$,.ELEMENT.,3.);
#6=IFCBUILDINGSTOREY('0Storey00000000000006',$,'Duplicate level',$,$,$,$,$,.ELEMENT.,7.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5,#6));
#41=IFCWALL('0Wall00000000000000041',$,'Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${rating}'),$);
#51=IFCPROPERTYSET('0Pset000000000000000051',$,'Pset_WallCommon',$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#41),#51);
ENDSEC; END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel(id, { idOffset: federationRegistry.registerModel(id, 52) }), name, ifcDataStore: store, maxExpressId: 52 };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
async function addBlock(ui: HTMLElement, label: string): Promise<void> {
  const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Add block'));
  assert.ok(trigger);
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  click(trigger);
  await settle();
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === label);
  assert.ok(item, `missing Add block item ${label}`);
  click(item);
  await settle();
}

describe('Document field source and page-break UI (#6485)', () => {
  beforeEach(async () => {
    federationRegistry.clear();
    const a = await parsedModel('a', 'Architecture.ifc', 'Architecture', 'REI60');
    const b = await parsedModel('b', 'Structure.ifc', 'Structure', 'REI120');
    const spec: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Coordination', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'text', style: 'body', text: '' }] };
    useViewerStore.setState({ models: new Map([[a.id, a], [b.id, b]]), activeModelId: a.id, documents: [spec], activeDocumentId: spec.id, dashboards: [], bcfProject: null, selectedEntityIds: new Set([federationRegistry.toGlobalId(b.id, 41)]), mutationViews: new Map(), mutationVersion: 0 });
  });
  afterEach(() => { cleanup(); localStorage.clear(); federationRegistry.clear(); });

  it('inserts scoped project and selected-element fields and retains their source through active-model changes, preview, export and persistence', async () => {
    const drawn: string[] = [];
    const seams = async (): Promise<DocumentPdfSeams> => ({ createDoc: async () => ({ addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {}, fillRect: () => {}, text: (value) => { drawn.push(value); }, addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => 1, output: () => new Blob(['pdf']) }), renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }) });
    const ui = render(<DocumentPanel pdfSeams={seams} />);
    await settle();
    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Field source model"]');
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Insert field"]');
    const textarea = ui.querySelector<HTMLTextAreaElement>('textarea');
    assert.ok(source && picker && textarea);
    await choose(source, 'b');
    const project = modelBindingPath('Structure.ifc', 'IfcProject.Name');
    const property = modelBindingPath('Structure.ifc', 'Element[0Wall00000000000000041].Pset_WallCommon.FireRating');
    assert.ok([...picker.options].some((option) => option.value === property), 'effective properties come from the selected model');
    await choose(picker, project);
    type(textarea, `${textarea.value} / `);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await choose(picker, property);
    await settle();
    const preview = ui.querySelector('[data-preview-block="text"] [data-block-text]');
    assert.equal(preview?.textContent, 'Structure / REI120');
    act(() => useViewerStore.setState({ activeModelId: 'b' }));
    await settle();
    assert.equal(preview?.textContent, 'Structure / REI120');
    act(() => useViewerStore.setState({ activeModelId: 'a' }));
    await settle();
    assert.equal(preview?.textContent, 'Structure / REI120');
    const saved = (await loadDocuments())[0];
    assert.ok(saved);
    const imported = parseDocumentFile(JSON.stringify(saved));
    assert.ok(imported.blocks[0].kind === 'text');
    assert.equal(imported.blocks[0].text, `{${project}} / {${property}}`);
    let downloaded = false;
    const onDownload = (): void => { downloaded = true; };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const exportButton = ui.querySelector('[data-document-export]');
      assert.ok(exportButton);
      click(exportButton);
      for (let i = 0; i < 20 && !downloaded; i++) await settle();
      assert.ok(downloaded);
    } finally { window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload); }
    assert.ok(drawn.includes('Structure / REI120'), 'PDF uses the same scoped binding as preview');
  });

  it('adds and removes a page break through the real menu, separating preview sheets and exported PDF pages', async () => {
    let page = 1;
    const ink: Array<{ text: string; page: number }> = [];
    const seams = async (): Promise<DocumentPdfSeams> => ({ createDoc: async () => ({ addPage: () => { page++; }, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {}, fillRect: () => {}, text: (text) => { ink.push({ text, page }); }, addImage: () => {}, svg: async () => {}, table: () => {}, pageCount: () => page, output: () => new Blob(['pdf']) }), renderSvg: () => '', capture: null, theme: DEFAULT_THEME, now: () => new Date(0), imageSize: async () => ({ w: 1, h: 1 }) });
    const ui = render(<DocumentPanel pdfSeams={seams} />);
    await settle();
    const first = ui.querySelector<HTMLTextAreaElement>('textarea');
    assert.ok(first);
    type(first, 'Before the break');
    await addBlock(ui, 'Page break');
    await addBlock(ui, 'Text with fields');
    const textareas = ui.querySelectorAll<HTMLTextAreaElement>('textarea');
    assert.equal(textareas.length, 2);
    type(textareas[1], 'After the break');
    await settle();
    assert.equal(ui.querySelectorAll('[data-preview-section]').length, 2);
    const saved = (await loadDocuments())[0];
    assert.ok(saved.blocks.some((block) => block.kind === 'page-break'));
    assert.ok(parseDocumentFile(JSON.stringify(saved)).blocks.some((block) => block.kind === 'page-break'));
    const exportButton = ui.querySelector('[data-document-export]');
    assert.ok(exportButton);
    click(exportButton);
    for (let i = 0; i < 20 && !ink.some((item) => item.text === 'After the break'); i++) await settle();
    assert.deepEqual(ink.filter((item) => item.text.includes('the break')), [{ text: 'Before the break', page: 1 }, { text: 'After the break', page: 2 }]);
    const remove = ui.querySelector('[data-block-kind="page-break"] [aria-label="Remove block"]');
    assert.ok(remove);
    click(remove);
    await settle();
    assert.equal(ui.querySelectorAll('[data-preview-section]').length, 1);
  });
  it('offers unique fields for duplicate storey names and resolves the chosen elevation', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    const source = ui.querySelector<HTMLSelectElement>('select[aria-label="Field source model"]');
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Insert field"]');
    assert.ok(source && picker);
    await choose(source, 'b');
    const values = [...picker.options].map((option) => option.value);
    assert.equal(new Set(values).size, values.length, 'duplicate labels never create duplicate option paths');
    const path = modelBindingPath('Structure.ifc', 'IfcBuildingStorey[2].Elevation');
    assert.ok(values.includes(path));
    await choose(picker, path);
    await settle();
    assert.equal(ui.querySelector('[data-preview-block="text"] [data-block-text]')?.textContent, '7.00 m');
  });
});
