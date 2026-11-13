/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving markup into a model that was REOPENED with markup already embedded
 * must replace that markup, not add a second copy beside it.
 *
 * Reproduction of the reported bug: a file saved with one measurement,
 * reopened, restored (the restore puts the same measurement back into
 * `Drawing2DState`) and saved again carried two tagged `IfcAnnotation`s. The
 * sweep before a save only looked at overlay entities created in this
 * session, never at tagged annotations that came from the file.
 *
 * The restore step is represented by passing the restored markup arrays
 * straight to `saveDrawingMarkupToModel` and recording the embedded
 * annotations as absorbed (`drawing-markup-absorbed.ts`), the two things a
 * restore that applies does; its real WASM read path is covered by
 * `overlay-parse/drawing-markup-read-real-roundtrip.test.ts` and its absorbed
 * bookkeeping by `hooks/drawingMarkupAbsorbed.test.tsx`. What this file pins is
 * the write side on a re-parsed store, through the real `IfcParser` +
 * `StepExporter`, including that embedded markup the session never absorbed
 * survives a save.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { saveDrawingMarkupToModel, type SaveMarkupInput } from './drawing-markup-save.js';
import { absorbEmbeddedMarkup } from './drawing-markup-absorbed.js';

const STOREY_ID = 30;

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
#${STOREY_ID}=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;
`;

const NO_MARKUP: SaveMarkupInput = {
  measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
};

const ONE_MEASURE: SaveMarkupInput = {
  ...NO_MARKUP,
  measure2DResults: [{ id: 'meas-1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
};

const EVERY_KIND: SaveMarkupInput = {
  measure2DResults: ONE_MEASURE.measure2DResults,
  polygonArea2DResults: [{
    id: 'area-1', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], area: 6, perimeter: 12,
  }],
  textAnnotations2D: [{ id: 'text-1', position: { x: 1, y: 1 }, text: 'note' }],
  cloudAnnotations2D: [{ id: 'cloud-1', points: [{ x: -1, y: -1 }, { x: 2, y: 2 }], label: 'check' }],
};

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Load `text` as model `m1`, the way opening a file does: a fresh store, no overlay. */
async function open(text: string): Promise<IfcDataStore> {
  const store = await parse(text);
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

function exportStep(store: IfcDataStore): string {
  const view = useViewerStore.getState().getMutationView('m1');
  const result = new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

function count(step: string, type: string): number {
  return (step.match(new RegExp(`=${type}\\(`, 'g')) ?? []).length;
}

/** `#N` references that no `#N=` line in the file defines. */
function danglingRefs(step: string): number[] {
  const data = step.slice(step.indexOf('DATA;'));
  const defined = new Set([...data.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1])));
  const body = data.replace(/'(?:[^']|'')*'/g, "''");
  return [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].filter((id) => !defined.has(id));
}

/** GlobalIds of the IfcLite markup annotations in `step`, keyed by tag. */
function markupGuids(step: string): Map<string, string> {
  const guids = new Map<string, string>();
  for (const m of step.matchAll(/=IFCANNOTATION\('([^']*)',[^;]*'(IfcLite:Markup:[A-Za-z]+)'/g)) guids.set(m[2], m[1]);
  return guids;
}

/** What a restore that applied does besides filling the arrays: record every embedded markup annotation as absorbed. */
function absorbAll(step: string): void {
  absorbEmbeddedMarkup('m1', markupGuids(step).values());
}

/** Save → export → reopen: the file a user gets back after a first session. */
async function reopenedWith(markup: SaveMarkupInput, restored = true): Promise<{ store: IfcDataStore; step: string }> {
  const first = await open(MINI_IFC);
  assert.equal(saveDrawingMarkupToModel('m1', markup).refusal, null);
  const step = exportStep(first);
  const store = await open(step);
  if (restored) absorbAll(step);
  return { store, step };
}

/** Every entity type the writer emits for a markup item, below the annotation itself. */
const MARKUP_DEPENDENT_TYPES = [
  'IFCPOLYLINE', 'IFCSHAPEREPRESENTATION', 'IFCPRODUCTDEFINITIONSHAPE', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
  'IFCELEMENTQUANTITY', 'IFCPROPERTYSET', 'IFCRELDEFINESBYPROPERTIES', 'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA',
  'IFCTEXTLITERALWITHEXTENT', 'IFCPLANAREXTENT', 'IFCANNOTATIONFILLAREA', 'IFCLOCALPLACEMENT', 'IFCCARTESIANPOINT',
];

describe('saveDrawingMarkupToModel on a reopened model with embedded markup', () => {
  it('replaces the embedded measurement instead of adding a second copy', async () => {
    const { store, step: firstFile } = await reopenedWith(ONE_MEASURE);
    assert.equal(count(firstFile, 'IFCANNOTATION'), 1);

    // Restore put the same measurement back into Drawing2DState; save again.
    const outcome = saveDrawingMarkupToModel('m1', ONE_MEASURE);
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.measuresSaved, 1);
    assert.equal(outcome.previousRemoved, 1, 'the annotation embedded in the file is the one this save replaces');

    const secondFile = exportStep(store);
    assert.equal(count(secondFile, 'IFCANNOTATION'), 1);
    assert.deepEqual(danglingRefs(secondFile), []);
    // The embedded annotation's representation, placement, quantity set and
    // its relationship went with it: the file is the same shape as after the
    // first save, not the first save plus orphans.
    for (const type of MARKUP_DEPENDENT_TYPES) {
      assert.equal(count(secondFile, type), count(firstFile, type), `${type} count changed across the re-save`);
    }
  });

  it('stays at one copy of every kind across a second reopen-and-save cycle', async () => {
    const { store, step: firstFile } = await reopenedWith(EVERY_KIND);
    assert.equal(count(firstFile, 'IFCANNOTATION'), 4);

    assert.equal(saveDrawingMarkupToModel('m1', EVERY_KIND).previousRemoved, 4);
    const secondFile = exportStep(store);
    const third = await open(secondFile);
    absorbAll(secondFile);
    assert.equal(saveDrawingMarkupToModel('m1', EVERY_KIND).previousRemoved, 4);
    const thirdFile = exportStep(third);

    for (const file of [secondFile, thirdFile]) {
      assert.equal(count(file, 'IFCANNOTATION'), 4);
      assert.deepEqual(danglingRefs(file), []);
      for (const type of MARKUP_DEPENDENT_TYPES) {
        assert.equal(count(file, type), count(firstFile, type), `${type} count changed across re-saves`);
      }
    }
  });

  it('removes the embedded markup when the session has no markup left to save', async () => {
    const { store } = await reopenedWith(EVERY_KIND);

    const outcome = saveDrawingMarkupToModel('m1', NO_MARKUP);
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 4);
    assert.ok(useViewerStore.getState().dirtyModels.has('m1'));

    const cleared = exportStep(store);
    assert.equal(count(cleared, 'IFCANNOTATION'), 0);
    assert.deepEqual(danglingRefs(cleared), []);
    for (const type of MARKUP_DEPENDENT_TYPES) {
      assert.equal(count(cleared, type), count(MINI_IFC, type), `${type} left behind after clearing markup`);
    }
  });

  it('keeps annotations that are not IfcLite markup, and geometry they share with markup', async () => {
    const { step } = await reopenedWith(ONE_MEASURE);
    // A foreign annotation (another tool's, untagged ObjectType) whose
    // representation reuses the markup's own polyline and placement.
    const markup = /^#(\d+)=IFCANNOTATION\('[^']*',#4,'Measurement',\$,'IfcLite:Markup:Measure',#(\d+),#(\d+)\);/m.exec(step);
    assert.ok(markup, 'expected the tagged measurement in the saved file');
    const [, , placementId, shapeId] = markup;
    const shape = new RegExp(`^#${shapeId}=IFCPRODUCTDEFINITIONSHAPE\\(\\$,\\$,\\(#(\\d+)\\)\\);`, 'm').exec(step);
    assert.ok(shape);
    const rep = new RegExp(`^#${shape[1]}=IFCSHAPEREPRESENTATION\\(#(\\d+),'Annotation','Curve2D',\\(#(\\d+)\\)\\);`, 'm').exec(step);
    assert.ok(rep);
    const [, contextId, polylineId] = rep;
    const foreign = [
      `#9001=IFCSHAPEREPRESENTATION(#${contextId},'Annotation','Curve2D',(#${polylineId}));`,
      '#9002=IFCPRODUCTDEFINITIONSHAPE($,$,(#9001));',
      `#9003=IFCANNOTATION('0foreign00000000000000',#4,'Grid note',$,'Vendor:Note',#${placementId},#9002);`,
      "#9004=IFCANNOTATION('0untagged0000000000000',#4,'Plain',$,$,$,$);",
    ].join('\n');
    const store = await open(step.replace(/^ENDSEC;\s*END-ISO-10303-21;/m, `${foreign}\nENDSEC;\nEND-ISO-10303-21;`));
    absorbAll(step);

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    const saved = exportStep(store);
    assert.equal(count(saved, 'IFCANNOTATION'), 2);
    assert.doesNotMatch(saved, /IfcLite:Markup:/);
    assert.match(saved, /'Vendor:Note'/);
    assert.match(saved, /'0untagged0000000000000'/);
    for (const id of [contextId, polylineId, placementId]) {
      assert.match(saved, new RegExp(`^#${id}=`, 'm'), `shared #${id} must survive`);
    }
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('removes styled items on markup geometry with it, keeping a style a survivor shares', async () => {
    const { step } = await reopenedWith(ONE_MEASURE);
    const polyline = /^#(\d+)=IFCPOLYLINE\(/m.exec(step);
    assert.ok(polyline, 'expected the measurement polyline in the saved file');
    const polylineId = polyline[1];
    const context = /^#(\d+)=IFCGEOMETRICREPRESENTATIONSUBCONTEXT\(/m.exec(step);
    assert.ok(context, 'expected the markup sub-context in the saved file');
    const contextId = context[1];
    // One style only the markup polyline uses, one shared with a foreign
    // annotation's styled polyline (a style edit or another tool could add
    // either). The writer itself emits no styled items.
    const styles = [
      '#9101=IFCCOLOURRGB($,0.,1.,0.);',
      '#9102=IFCCURVESTYLE($,$,$,#9101,$);',
      `#9103=IFCSTYLEDITEM(#${polylineId},(#9102),$);`,
      '#9111=IFCCOLOURRGB($,1.,0.,0.);',
      '#9112=IFCCURVESTYLE($,$,$,#9111,$);',
      `#9113=IFCSTYLEDITEM(#${polylineId},(#9112),$);`,
      '#9120=IFCCARTESIANPOINT((9.,9.));',
      '#9121=IFCPOLYLINE((#9120,#9120));',
      '#9122=IFCSTYLEDITEM(#9121,(#9112),$);',
      `#9123=IFCSHAPEREPRESENTATION(#${contextId},'Annotation','Curve2D',(#9121));`,
      '#9124=IFCPRODUCTDEFINITIONSHAPE($,$,(#9123));',
      "#9125=IFCANNOTATION('0styled00000000000000',#4,'Styled note',$,'Vendor:Note',$,#9124);",
    ].join('\n');
    const store = await open(step.replace(/^ENDSEC;\s*END-ISO-10303-21;/m, `${styles}\nENDSEC;\nEND-ISO-10303-21;`));
    absorbAll(step);

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    const saved = exportStep(store);
    for (const id of [polylineId, '9101', '9102', '9103', '9113']) {
      assert.doesNotMatch(saved, new RegExp(`^#${id}=`, 'm'), `#${id} only decorated removed markup`);
    }
    for (const id of ['9111', '9112', '9120', '9121', '9122', '9125']) {
      assert.match(saved, new RegExp(`^#${id}=`, 'm'), `shared #${id} must survive`);
    }
    assert.deepEqual(danglingRefs(saved), []);
  });
});

describe('saveDrawingMarkupToModel keeps embedded markup the session never absorbed', () => {
  const OTHER_MEASURE: SaveMarkupInput = {
    ...NO_MARKUP,
    measure2DResults: [{ id: 'user-1', start: { x: 1, y: 1 }, end: { x: 1, y: 3 }, distance: 2 }],
  };

  it('writes the new markup beside embedded markup the restore never loaded (the user drew first)', async () => {
    const { store, step } = await reopenedWith(ONE_MEASURE, false);
    const embedded = markupGuids(step).get('IfcLite:Markup:Measure');
    assert.ok(embedded);

    const outcome = saveDrawingMarkupToModel('m1', OTHER_MEASURE);
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 0);

    const saved = exportStep(store);
    assert.equal(count(saved, 'IFCANNOTATION'), 2, 'the embedded measurement and the new one');
    assert.match(saved, new RegExp(`'${embedded}'`), 'the embedded measurement survives the save');
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('an empty-session save clears only absorbed markup, so with nothing absorbed it has nothing to clear', async () => {
    const { store, step } = await reopenedWith(EVERY_KIND, false);

    const outcome = saveDrawingMarkupToModel('m1', NO_MARKUP);
    assert.equal(outcome.refusal, 'nothing-to-save');
    assert.equal(outcome.previousRemoved, 0);
    assert.equal(useViewerStore.getState().dirtyModels.has('m1'), false);
    assert.equal(count(exportStep(store), 'IFCANNOTATION'), count(step, 'IFCANNOTATION'));
  });

  it('replaces only the absorbed annotations of a file carrying several', async () => {
    const { store, step } = await reopenedWith(EVERY_KIND, false);
    const guids = markupGuids(step);
    absorbEmbeddedMarkup('m1', [guids.get('IfcLite:Markup:Measure')!]);

    assert.equal(saveDrawingMarkupToModel('m1', ONE_MEASURE).previousRemoved, 1);
    const saved = exportStep(store);
    assert.equal(count(saved, 'IFCANNOTATION'), 4, 'three kept embedded annotations and the re-saved measurement');
    assert.doesNotMatch(saved, new RegExp(`'${guids.get('IfcLite:Markup:Measure')}'`));
    for (const tag of ['IfcLite:Markup:PolygonArea', 'IfcLite:Markup:Text', 'IfcLite:Markup:Cloud']) {
      assert.ok(guids.get(tag), `expected ${tag} in the first file`);
      assert.match(saved, new RegExp(`'${guids.get(tag)}'`), `${tag} was never absorbed and must survive`);
    }
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('matches an annotation without a GlobalId by its express id', async () => {
    const { step } = await reopenedWith(ONE_MEASURE, false);
    const markup = /^#(\d+)=IFCANNOTATION\('([^']*)'/m.exec(step);
    assert.ok(markup);
    const store = await open(step.replace(`'${markup[2]}'`, '$'));
    absorbEmbeddedMarkup('m1', [`#${markup[1]}`]);

    assert.equal(saveDrawingMarkupToModel('m1', ONE_MEASURE).previousRemoved, 1);
    assert.equal(count(exportStep(store), 'IFCANNOTATION'), 1);
  });

  it('forgets what was absorbed when the model id is loaded again', async () => {
    const { step } = await reopenedWith(ONE_MEASURE);
    const store = await open(step); // same bytes, but a new load: nothing restored yet
    assert.equal(saveDrawingMarkupToModel('m1', OTHER_MEASURE).previousRemoved, 0);
    assert.equal(count(exportStep(store), 'IFCANNOTATION'), 2);
  });
});
