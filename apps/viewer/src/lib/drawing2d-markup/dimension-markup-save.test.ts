/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dimensions through the "save markup into model" action: what
 * `dimensionSaveParams` hands the writer, and that saving again replaces the
 * previous save instead of stacking a second copy. Real `IfcParser` fixture
 * and `StepExporter`, as `drawing-markup-save.test.ts`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { dimensionGraphics, formatDimensionValue } from './dimension-graphics.js';
import { dimensionPaperScale, dimensionSaveParams, findInvalidDimension } from './dimension-markup-save.js';
import { decodeDimensionPlane, decodeDimensionRef } from './dimension-markup-codec.js';
import { saveDrawingMarkupToModel, type SaveMarkupInput } from './drawing-markup-save.js';

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('markup','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',#4,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#6=IFCUNITASSIGNMENT((#2));
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#20=IFCLOCALPLACEMENT($,#8);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;
`;

const DIM: Dimension2D = {
  id: 'dim-1',
  a: { x: 0, y: 0 },
  b: { x: 4.2624, y: 0 },
  offset: 0.6,
  orientation: 'aligned',
  refs: { b: { globalId: '2O2Fr$t4X7Zf8NOew3FL9r', ifcType: 'IfcWall' } },
  plane: { axis: 'side', position: 25, flipped: false },
};

async function seedStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  useViewerStore.setState({
    editEnabled: true,
    activeModelId: 'm1',
    models: new Map([['m1', { id: 'm1', name: 'markup.ifc', ifcDataStore: store, visible: true, loadedAt: 1 } as never]]),
    mutationViews: new Map(),
    storeEditors: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
  } as never);
  return store;
}

function input(dimensions: Dimension2D[]): SaveMarkupInput {
  return {
    measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    dimensions2D: dimensions.map((d) => dimensionSaveParams(d, { paperScale: 100 })),
  };
}

const annotations = () =>
  (useViewerStore.getState().getMutationView('m1')?.getNewEntities() ?? []).filter((e) => e.type === 'IfcAnnotation');

function exportStep(store: IfcDataStore): string {
  const view = useViewerStore.getState().getMutationView('m1');
  return new TextDecoder().decode(new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true }).content);
}

describe('dimensionSaveParams', () => {
  it('passes the shared graphics, laid out with the dimension\'s own section flip', () => {
    const params = dimensionSaveParams(DIM, { paperScale: 100, drawnPlane: { axis: 'down', position: 50, flipped: false } });
    const expected = dimensionGraphics(DIM, {
      paperScale: 100, format: (m) => formatDimensionValue(m), flip: { flipX: true, flipY: true },
    });
    assert.deepEqual(params.lines, expected.lines);
    assert.deepEqual(params.ticks, expected.ticks);
    assert.deepEqual(params.label, {
      position: expected.text.at, value: '4262', angle: expected.text.angle, height: expected.text.heightM,
    });
    assert.equal(params.distance, expected.measured);
    assert.equal(params.offset, 0.6);
    assert.equal(params.text, undefined);
    assert.equal(params.refA, undefined);
    assert.deepEqual(decodeDimensionRef(params.refB ?? ''), DIM.refs?.b);
    assert.deepEqual(decodeDimensionPlane(params.plane ?? ''), DIM.plane);
    assert.equal(findInvalidDimension(params), null);
  });

  it('writes no Plane for an unstamped dimension, so it stays on every cut after a reload', () => {
    const { plane: _plane, ...unstamped } = DIM;
    assert.equal(dimensionSaveParams(unstamped, { paperScale: 100, drawnPlane: DIM.plane }).plane, undefined);
  });

  it('picks the sheet scale when a sheet is on, else the drawing scale', () => {
    const base = { activeSheet: { scale: { factor: 50 } }, drawing2DDisplayOptions: { scale: 200 } };
    assert.equal(dimensionPaperScale({ ...base, sheetEnabled: true }), 50);
    assert.equal(dimensionPaperScale({ ...base, sheetEnabled: false }), 200);
    assert.equal(dimensionPaperScale({ ...base, sheetEnabled: true, activeSheet: null }), 200);
  });
});

describe('saveDrawingMarkupToModel with dimensions', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('writes one tagged dimension annotation and counts it', () => {
    const outcome = saveDrawingMarkupToModel('m1', input([DIM]));
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.dimensionsSaved, 1);
    assert.equal(annotations().length, 1);
    assert.match(exportStep(store), /'IfcLite:Markup:Dimension'/);
  });

  it('saving again replaces the saved dimensions rather than duplicating them', () => {
    saveDrawingMarkupToModel('m1', input([DIM]));
    const second = saveDrawingMarkupToModel('m1', input([DIM, { ...DIM, id: 'dim-2', offset: -0.3 }]));
    assert.equal(second.previousRemoved, 1);
    assert.equal(second.dimensionsSaved, 2);
    assert.equal(annotations().length, 2);
    const step = exportStep(store);
    assert.equal((step.match(/=IFCANNOTATION\(/g) ?? []).length, 2);
    assert.equal((step.match(/IFCTEXTLITERALWITHEXTENT\(/g) ?? []).length, 2, 'no orphaned text from the first save');

    const cleared = saveDrawingMarkupToModel('m1', input([]));
    assert.equal(cleared.previousRemoved, 2);
    assert.equal(annotations().length, 0);
  });

  it('refuses a non-finite dimension before sweeping the previous save', () => {
    saveDrawingMarkupToModel('m1', input([DIM]));
    const bad = input([DIM]);
    bad.dimensions2D[0] = { ...bad.dimensions2D[0], ticks: [[{ x: 0, y: 0 }, { x: Infinity, y: 0 }]] };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(saveDrawingMarkupToModel('m1', bad).refusal, 'invalid-markup');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(annotations().length, 1, 'the earlier save survives');
  });
});
