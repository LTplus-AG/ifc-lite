/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { resolveElementTagLabel, resolveElementTagAnchor } from './element-tags.js';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
const tag = (entityId: number) => ({ id: `tag-${entityId}`, modelId: 'm', entityId,
  anchor: { x: 0, y: 0 }, offset: { x: 0.2, y: 0.3 }, template: 'auto' as const });

async function fixture() {
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCDOOR('0Door00000000000000010',$,'Entrance',$,$,$,$,$,2.1,0.9,$,$,$);
#11=IFCWINDOW('0Window000000000000011',$,'Window',$,$,$,$,'W-01',1.2,1.0,$,$,$);
#20=IFCSPACE('0Space0000000000000020',$,'Office',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#21=IFCQUANTITYAREA('NetFloorArea',$,$,19.2,$);
#22=IFCELEMENTQUANTITY('0Quantity0000000000022',$,'Qto_SpaceBaseQuantities',$,$,(#21));
#23=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000023',$,$,$,(#20),#22);
ENDSEC;
END-ISO-10303-21;`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'm');
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }), mutationViews: new Map([['m', view]]) });
  return { store, view };
}

it('#9296 tags read door/window marks and space Name with net floor area', async () => {
  await fixture();
  assert.equal(resolveElementTagLabel(tag(10)), 'Entrance');
  assert.equal(resolveElementTagLabel(tag(11)), 'W-01');
  assert.equal(resolveElementTagLabel(tag(20)), 'Office · ≈ 19.2 m²');
});

it('#9296 labels follow current property edits and deletion', async () => {
  const { view } = await fixture();
  view.setAttribute(10, 'Name', 'Renamed <door>');
  assert.equal(resolveElementTagLabel(tag(10)), 'Renamed <door>');
  view.setAttribute(10, 'Tag', 'D-01');
  assert.equal(resolveElementTagLabel(tag(10)), 'D-01');
  view.deleteEntity(10);
  assert.equal(resolveElementTagLabel(tag(10)), null);
});

it('#9296 anchors follow regenerated entity polygons and preserve the user offset', () => {
  const polygon = (x: number) => ({ polygon: { outer: [{x,y:0},{x:x+2,y:0},{x:x+2,y:2},{x,y:2}], holes: [] },
    entityId: 10, modelIndex: 0, ifcType: 'IfcDoor', isCut: true });
  // A drawing fragment suffices: the invariant depends only on its polygon collections.
  assert.deepEqual(resolveElementTagAnchor(tag(10), [polygon(0)], 10), { x: 1.2, y: 1.3 });
  assert.deepEqual(resolveElementTagAnchor(tag(10), [polygon(5)], 10), { x: 6.2, y: 1.3 });
});

it('#9296 the real SVG download contains escaped, live entity tags', async () => {
  const { view } = await fixture();
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: useDrawingExport } = await import('@/hooks/useDrawingExport.js');
  const { GraphicOverrideEngine } = await import('@ifc-lite/drawing-2d');
  useViewerStore.setState({ tagAnnotations2D: [tag(10), tag(20)] });
  view.setAttribute(10, 'Name', 'Entry <A>');
  const drawing: import('@ifc-lite/drawing-2d').Drawing2D = {
    config: { plane: { axis: 'z', position: 1, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 50 },
    lines: [], cutPolygons: [], projectionPolygons: [], bounds: { min: { x: 0, y: 0 }, max: { x: 5, y: 4 } },
    stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
  };
  let save: (() => void) | undefined;
  function Harness() {
    save = useDrawingExport({ drawing, displayOptions: { showHiddenLines: true, scale: 50,
      showScanSection: false, scanSectionOpacity: 0, scanSectionIncludeInExport: false },
      sectionPlane: { axis: 'down', position: 1, flipped: false }, activePresetId: null,
      entityColorMap: new Map(), overridesEnabled: false, overrideEngine: new GraphicOverrideEngine(),
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
      sheetEnabled: false, activeSheet: null, dxfUnderlays: [], ifcDataStore: null,
      coordinateInfo: undefined, scanSection: { points: [] } }).handleExportSVG;
    return null;
  }
  const original = URL.createObjectURL;
  let blob: Blob | undefined;
  URL.createObjectURL = value => { if (value instanceof Blob) blob = value; return 'blob:tag-test'; };
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { save!(); });
    assert.ok(blob, 'the real download was emitted');
    const doc = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml');
    assert.equal(doc.querySelector('parsererror'), null);
    assert.match(doc.querySelector('#element-tags')?.textContent ?? '', /Entry <A>/);
    assert.match(doc.querySelector('#element-tags')?.textContent ?? '', /19\.2 m²/);
    view.setAttribute(10, 'Name', 'Renamed entry');
    await act(async () => { save!(); });
    assert.match(await blob.text(), /Renamed entry/);
  } finally {
    URL.createObjectURL = original;
    await act(async () => root.unmount()); node.remove();
  }
});

it('#9296 DXF exports real TEXT entities and scaled PDF writes the live labels', async () => {
  await fixture();
  const { exportToDXF, parseDxf, DEFAULT_SECTION_CONFIG } = await import('@ifc-lite/drawing-2d');
  const { elementTagsDxf, drawElementTagsPdf } = await import('./element-tag-export.js');
  const { resolvedElementTags } = await import('./element-tags.js');
  const { jsPDF } = await import('jspdf');
  useViewerStore.setState({ tagAnnotations2D: [tag(10), tag(20)] });
  const drawing: import('@ifc-lite/drawing-2d').Drawing2D = {
    config: DEFAULT_SECTION_CONFIG, lines: [], cutPolygons: [], projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 5, y: 4 } },
    stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
  };
  const document = parseDxf(exportToDXF(drawing, { underlays: [elementTagsDxf(drawing, 0.175)] }));
  const texts = document.entities.filter(entity => entity.kind === 'text');
  assert.equal(texts.length, 2);
  assert.ok(texts.some(entity => entity.text === 'Entrance'));
  assert.ok(texts.some(entity => /Office.*19\.2/.test(entity.text)));
  const pdf = new jsPDF();
  drawElementTagsPdf(pdf, resolvedElementTags(drawing), (x, y) => ({ x: x*20+10, y: y*20+10 }));
  const output = pdf.output();
  assert.match(output, /Entrance/);
  assert.match(output, /19\.2/);
});
