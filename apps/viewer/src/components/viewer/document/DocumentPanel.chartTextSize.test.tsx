/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { ChartSpec } from '@ifc-lite/charts';
import { composeDocument } from '@/lib/document/compose';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec } from '@/lib/document/types';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { click, cleanup, render, type as typeInput } from '@/test/render';
import { useViewerStore } from '@/store';
import { DocumentPanel } from './DocumentPanel';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Typography',$,$,$,$,$,$);
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
ENDSEC;END-ISO-10303-21;`;
const chart: ChartSpec = { id: 'by-type', title: 'Products by class', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } };
const doc: DocumentSpec = { version: DOCUMENT_VERSION, id: 'typography', name: 'Chart typography', page: { size: 'A4', orientation: 'portrait' },
  blocks: [{ kind: 'chart', id: 'c1', chart, snapshot: false, height: 150 }, { kind: 'chart', id: 'c2', chart, snapshot: false, height: 150 }] };
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const fontSizes = (svg: Element) => [...svg.querySelectorAll<SVGTextElement>('text')].map((text) => Number.parseFloat(text.style.fontSize));

describe('Document chart text sizing (#6546)', () => {
  beforeEach(async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer);
    const model = { ...fixtureModel('m'), ifcDataStore: store, maxExpressId: 44 };
    useViewerStore.setState({ ...fixtureModels(model), documents: [doc], activeDocumentId: doc.id, dashboards: [],
      selectedEntityIds: new Set(), mutationViews: new Map(), mutationVersion: 0, bcfProject: null });
  });
  afterEach(cleanup);

  it('edits, persists and imports the chosen font through the real SVG renderer, then resets', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    const preview = () => ui.querySelector('[data-preview-block="c2"] svg');
    assert.ok(preview(), 'the parsed IFC model fills the chart');
    const before = fontSizes(preview()!);
    const editor = ui.querySelector('[data-block-editor="c2"]'); assert.ok(editor);
    const size = editor.querySelector<HTMLInputElement>('input[aria-label="Chart text size"]'); assert.ok(size);
    typeInput(size, '8');
    act(() => size.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    await settle();
    const after = fontSizes(preview()!);
    assert.ok(after.length > 0 && Math.max(...after) < Math.max(...before), 'rendered SVG axes actually use smaller text');
    assert.ok(fontSizes(ui.querySelector('[data-preview-block="c1"] svg')!).includes(12), 'the other block retains its default');
    const persisted = loadDocuments().find((d) => d.id === doc.id); assert.ok(persisted);
    const imported = parseDocumentFile(JSON.stringify(persisted));
    assert.equal(imported.blocks[1].kind === 'chart' && imported.blocks[1].fontSize, 8);
    assert.equal(imported.blocks[0].kind === 'chart' && imported.blocks[0].fontSize, undefined);
    click([...editor.querySelectorAll('button')].find((button) => button.textContent === 'Reset chart text size')!);
    await settle();
    assert.deepEqual(fontSizes(preview()!), before, 'reset restores the original rendered typography');
    const reset = loadDocuments().find((d) => d.id === doc.id)?.blocks[1];
    assert.equal(reset?.kind === 'chart' && reset.fontSize, undefined);
  });

  it('reclaims PDF heading space while preserving the requested chart height', () => {
    const layout = (fontSize?: number) => composeDocument({
      name: 'Typography', page: doc.page, generatedAt: '2026-09-30',
      blocks: [{ kind: 'chart', id: 'chart', title: chart.title, subtitle: '2 buckets · 3', hasData: true, snapshot: false, height: 150, fontSize }],
      measure: (text, size) => text.length * size / 2,
    });
    const base = layout(); const small = layout(8);
    const baseItems = base.pages[0].items; const smallItems = small.pages[0].items;
    const baseChart = baseItems.find((item) => item.kind === 'chart');
    const smallChart = smallItems.find((item) => item.kind === 'chart');
    assert.ok(baseChart?.kind === 'chart' && smallChart?.kind === 'chart');
    assert.equal(smallChart.h, baseChart.h);
    assert.ok(smallChart.y < baseChart.y, 'scaled title strip returns space to the page');
    const heading = smallItems.find((item) => item.kind === 'text' && item.text === chart.title);
    assert.ok(heading?.kind === 'text'); assert.equal(heading.size, 11 * 8 / 12);
  });

  it('validates finite sizes and preserves documents with no optional override', () => {
    assert.deepEqual(validateDocumentSpec(doc), []);
    for (const fontSize of [6, 8, 12, 24]) assert.deepEqual(validateDocumentSpec({ ...doc, blocks: [{ ...doc.blocks[0], fontSize }] }), []);
    for (const fontSize of [5, 25, NaN, Infinity, '8', null]) assert.ok(validateDocumentSpec({ ...doc, blocks: [{ ...doc.blocks[0], fontSize }] }).some((error) => error.path === 'blocks[0].fontSize'));
    for (const version of [1, DOCUMENT_VERSION]) {
      const restored = parseDocumentFile(JSON.stringify({ ...doc, version }));
      assert.ok(restored.blocks.every((block) => block.kind === 'chart' && block.fontSize === undefined));
    }
  });
});
