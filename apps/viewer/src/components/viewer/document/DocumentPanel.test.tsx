/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Document panel (#4594) over a parsed model: it seeds a blank page
 * whose title reads the project name, a field inserted from the picker
 * resolves live in the preview, an unresolved one is marked, blocks
 * reorder and delete, a preset adds a document, and "Export PDF" prints
 * the resolved page through the seams and downloads it.
 */
import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { DEFAULT_THEME, renderChartSvg } from '@ifc-lite/charts';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { render, click, cleanup } from '@/test/render.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { DocumentPanel, ensureActiveDocument } from './DocumentPanel.js';

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

const change = async (el: HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    // React listens to the native setter's input event; set through the prototype so the tracker sees the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new window.Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

describe('DocumentPanel over a parsed model (#4594)', () => {
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
    });
  });
  afterEach(() => cleanup());

  it('seeds a blank page whose title reads the project name, and the seed is idempotent', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    ensureActiveDocument();
    assert.equal(useViewerStore.getState().documents.length, 1);
    const title = ui.querySelector('[data-preview-block] [data-block-text]');
    assert.equal(title?.textContent, 'Tower');
    assert.equal(ui.querySelectorAll('[data-block-editor]').length, 2);
  });

  it('a field inserted from the picker resolves live; a binding the model cannot answer is marked, not blanked', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    const body = ui.querySelectorAll<HTMLElement>('[data-block-editor]')[1]!;
    const picker = body.querySelector<HTMLSelectElement>('select[aria-label="Insert field"]')!;
    assert.ok([...picker.options].some((o) => o.value === 'IfcBuildingStorey["Level 1"].Elevation'), 'the model\'s storeys are offered');
    await change(picker, 'Count[IfcWall]');
    await settle();
    const textarea = body.querySelector<HTMLTextAreaElement>('textarea')!;
    assert.equal(textarea.value, '{Count[IfcWall]}');
    await change(textarea, 'Walls: {Count[IfcWall]} on {IfcBuildingStorey["Roof"].Name}');
    await settle();
    const preview = ui.querySelectorAll('[data-preview-block] [data-block-text]')[1]!;
    assert.equal(preview.textContent, 'Walls: 2 on [IfcBuildingStorey["Roof"].Name: no IfcBuildingStorey "Roof"]');
    const marked = preview.querySelector('[data-unresolved]');
    assert.ok(marked, 'the unresolved binding is marked');
    assert.equal(marked.getAttribute('title'), 'no IfcBuildingStorey "Roof"');
    // The template is what is saved — not the resolved text.
    assert.equal((useViewerStore.getState().documents[0].blocks[1] as { text: string }).text, 'Walls: {Count[IfcWall]} on {IfcBuildingStorey["Roof"].Name}');
  });

  it('blocks move and delete, a preset adds a document, and the page setup is saved on the document', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    click(ui.querySelectorAll('[data-block-editor]')[1]!.querySelector('button[aria-label="Move block up"]')!);
    await settle();
    assert.equal(useViewerStore.getState().documents[0].blocks[1].kind, 'text');
    assert.equal((useViewerStore.getState().documents[0].blocks[1] as { style: string }).style, 'title', 'the title moved down');
    click(ui.querySelectorAll('[data-block-editor]')[0]!.querySelector('button[aria-label="Remove block"]')!);
    await settle();
    assert.equal(useViewerStore.getState().documents[0].blocks.length, 1);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Document"]')!;
    await change(picker, 'preset:Cover sheet');
    await settle();
    const docs = useViewerStore.getState().documents;
    assert.equal(docs.length, 2);
    assert.equal(docs[1].name, 'Cover sheet');
    assert.equal(useViewerStore.getState().activeDocumentId, docs[1].id);
    // The cover sheet's chart block aggregates over the model in the preview.
    assert.ok(ui.querySelector('[data-chart-svg] svg'), 'the chart block renders its SVG');
    await change(ui.querySelector<HTMLSelectElement>('select[aria-label="Orientation"]')!, 'landscape');
    await settle();
    assert.equal(useViewerStore.getState().documents[1].page.orientation, 'landscape');
  });

  it('"Export PDF" prints the resolved page through the seams and downloads it', async () => {
    const drawn: string[] = [];
    let created: [string, string] | null = null;
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async (format, orientation) => {
        created = [format, orientation];
        return {
          addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
          text: (t) => { drawn.push(`text:${t}`); },
          addImage: () => { drawn.push('image'); },
          svg: async (svg) => { drawn.push(`svg:${svg.length > 100 ? 'ok' : 'short'}`); },
          table: () => {},
          pageCount: () => 1,
          output: () => new Blob(['pdf']),
        };
      },
      renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
      capture: async (ids) => new Uint8Array(ids.length),
      theme: DEFAULT_THEME,
      now: () => new Date(0),
      imageSize: async () => ({ w: 2, h: 1 }),
    });
    const downloads: string[] = [];
    const onDownload = (e: Event): void => { downloads.push(String((e as CustomEvent<{ kind: string }>).detail.kind)); };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const ui = render(<DocumentPanel pdfSeams={seams} />);
      await settle();
      await change(ui.querySelector<HTMLSelectElement>('select[aria-label="Document"]')!, 'preset:Cover sheet');
      await settle();
      click(ui.querySelector('[data-document-export]')!);
      for (let i = 0; i < 20 && downloads.length === 0; i++) await settle();
      assert.deepEqual(created, ['a4', 'portrait']);
      assert.deepEqual(downloads, ['pdf']);
      assert.ok(drawn.includes('text:Tower'), drawn.join(' | '));
      assert.ok(drawn.some((d) => d.startsWith('text:Site: Site')));
      assert.equal(drawn.filter((d) => d === 'svg:ok').length, 1, 'the chart block is a vector chart');
      assert.equal(drawn.filter((d) => d === 'image').length, 1, 'and its 3D snapshot');
    } finally {
      window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    }
  });
});
