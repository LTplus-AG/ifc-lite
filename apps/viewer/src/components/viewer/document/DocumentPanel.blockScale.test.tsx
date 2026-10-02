/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-block size (#6548) in the editor and the preview: every block with text or graphics has the one
 * control, a spacer does not, the composed preview scales the same geometry as PDF, and the choice
 * is saved.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { ChartSpec } from '@ifc-lite/charts';
import { loadDocuments } from '@/lib/document/persistence';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render, type as typeInput } from '@/test/render';
import { useViewerStore } from '@/store';
import { DocumentPanel } from './DocumentPanel';
import { documentPreviewReady } from '@/test/document-preview';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Sized',$,$,$,$,$,$);
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
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`;
const chart: ChartSpec = { id: 'by-type', title: 'Products by class', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } };
const doc: DocumentSpec = { version: DOCUMENT_VERSION, id: 'sized', name: 'Sized', page: { size: 'A4', orientation: 'portrait' }, blocks: [
  { kind: 'chart', id: 'c1', chart, snapshot: false, height: 150 },
  { kind: 'text', id: 't1', style: 'body', text: 'Body text' },
  { kind: 'spacer', id: 's1', height: 20 },
] };
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const SIZE = 'input[aria-label="Block size percentage"]';
const commit = async (input: HTMLInputElement, value: string) => {
  typeInput(input, value);
  act(() => input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  await settle();
};
const saved = (id: string) => loadDocuments().find((d) => d.id === doc.id)?.blocks.find((b) => b.id === id) as { scale?: number } | undefined;

describe('Document block size (#6548)', () => {
  beforeEach(async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer);
    const model = { ...fixtureModel('m'), ifcDataStore: store, maxExpressId: 44 };
    useViewerStore.setState({ ...fixtureModels(model), documents: [doc], activeDocumentId: doc.id, dashboards: [],
      selectedEntityIds: new Set(), mutationViews: new Map(), mutationVersion: 0, bcfProject: null });
  });
  afterEach(cleanup);

  it('offers the control on a chart and a text block, not on a spacer', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    assert.ok(ui.querySelector(`[data-block-editor="c1"] ${SIZE}`));
    assert.ok(ui.querySelector(`[data-block-editor="t1"] ${SIZE}`));
    assert.equal(ui.querySelector(`[data-block-editor="s1"] ${SIZE}`), null);
  });

  it('zooms a chart block as a whole: the plot is laid out at the authored size in a narrower column, then drawn larger', async () => {
    const ui = render(<DocumentPanel />);
    await settle(); await documentPreviewReady();
    const block = () => ui.querySelector('[data-preview-block="c1"]')!;
    const svg = () => block().querySelector('svg')!;
    const frame = () => block().querySelector<HTMLElement>('[data-chart-svg]')!;
    const placedHeight = parseFloat(frame().style.height), placedWidth = parseFloat(frame().style.width);
    const [width, height] = [Number(svg().getAttribute('width')), Number(svg().getAttribute('height'))];
    assert.ok(width > 0 && height > 0, 'the model fills the chart');
    await commit(ui.querySelector<HTMLInputElement>(`[data-block-editor="c1"] ${SIZE}`)!, '150');
    await documentPreviewReady();
    assert.ok(Math.abs(parseFloat(frame().style.height) - placedHeight * 1.5) < 0.01, 'the actual composed plot is placed 1.5 times taller');
    assert.ok(Math.abs(parseFloat(frame().style.width) - placedWidth) < 0.01, 'the plot keeps its printable column width');
    assert.ok(Math.abs(Number(svg().getAttribute('width')) - width / 1.5) < 1, 'the column the plot is laid out in is 1.5 times narrower');
    assert.equal(Number(svg().getAttribute('height')), height, 'at the authored height, which the zoom then scales with the text');
    assert.equal(saved('c1')?.scale, 1.5);
  });

  it('zooms a text block, clamps the entry to 50-200 and clears the override at 100', async () => {
    const ui = render(<DocumentPanel />);
    await settle(); await documentPreviewReady();
    const text = () => Array.from(ui.querySelectorAll<HTMLElement>('[data-preview-block="t1"] [data-block-text] span')).find(node => node.textContent?.trim() === 'Body text')!;
    const authoredSize = parseFloat(text().style.fontSize);
    const input = () => ui.querySelector<HTMLInputElement>(`[data-block-editor="t1"] ${SIZE}`)!;
    await commit(input(), '999');
    await documentPreviewReady();
    assert.ok(Math.abs(parseFloat(text().style.fontSize) - authoredSize * 2) < 0.01, 'the actual glyph doubles after upper clamping');
    assert.equal(saved('t1')?.scale, 2);
    await commit(input(), '1');
    await documentPreviewReady();
    assert.ok(Math.abs(parseFloat(text().style.fontSize) - authoredSize * 0.5) < 0.01, 'the actual glyph halves after lower clamping');
    await commit(input(), '100');
    await documentPreviewReady();
    assert.ok(Math.abs(parseFloat(text().style.fontSize) - authoredSize) < 0.01, 'clearing the override restores the authored glyph size');
    assert.equal('scale' in (saved('t1') ?? {}), false, 'the saved block carries no scale again');
  });
});
