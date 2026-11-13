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

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { saveDrawingMarkupToModel, type SaveMarkupInput } from './drawing-markup-save.js';
import { absorbEmbeddedMarkup, absorbedEmbeddedMarkupFor } from './drawing-markup-absorbed.js';
import { restoredEmbeddedMarkupIdentities } from './drawing-markup-restore.js';
import { dimensionSaveParams } from './dimension-markup-save.js';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { getDrawingMarkupModelContext } from './drawing-markup-context.js';
import { StoreEditor } from '@ifc-lite/mutations';

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
  measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [], dimensions2D: [],
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
  dimensions2D: [],
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

describe('saveDrawingMarkupToModel reads relationships with session edits applied', () => {
  /**
   * Reopen with one measurement plus an untagged annotation B (#9004) and a
   * vendor property relationship #9005 that relates only B. Returns the
   * measurement A and the property relationship the writer made for it (in
   * the source it relates only A).
   */
  async function reopenedWithForeign() {
    const { step } = await reopenedWith(ONE_MEASURE, false);
    const markup = /^#(\d+)=IFCANNOTATION\(/m.exec(step);
    assert.ok(markup);
    const markupId = Number(markup[1]);
    const rel = new RegExp(`^#(\\d+)=IFCRELDEFINESBYPROPERTIES\\([^;]*\\(#${markupId}\\),#(\\d+)\\);`, 'm').exec(step);
    assert.ok(rel, 'expected the measurement\'s property relationship');
    const foreign = [
      "#9004=IFCANNOTATION('0untagged0000000000000',#4,'Plain',$,$,$,$);",
      "#9005=IFCRELDEFINESBYPROPERTIES('0vendorRel000000000000',#4,$,$,(#9004),#9006);",
      "#9006=IFCPROPERTYSET('0vendorPset00000000000',#4,'Vendor',$,(#9007));",
      "#9007=IFCPROPERTYSINGLEVALUE('Note',$,IFCLABEL('kept'),$);",
    ].join('\n');
    const store = await open(step.replace(/^ENDSEC;\s*END-ISO-10303-21;/m, `${foreign}\nENDSEC;\nEND-ISO-10303-21;`));
    absorbAll(step);
    const context = getDrawingMarkupModelContext('m1');
    assert.ok(context);
    return { store, view: context.view, markupId, relId: Number(rel[1]), psetId: Number(rel[2]) };
  }

  function assertKept(saved: string, ...ids: number[]): void {
    for (const id of ids) assert.match(saved, new RegExp(`^#${id}=`, 'm'), `#${id} must survive`);
  }

  it('keeps a relationship a session edit extended to an untagged annotation', async () => {
    const { store, view, markupId, relId, psetId } = await reopenedWithForeign();
    view.setPositionalAttribute(relId, 4, [`#${markupId}`, '#9004']);

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    const saved = exportStep(store);
    assertKept(saved, relId, psetId, 9004, 9005, 9006, 9007);
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('keeps a relationship a named RelatedObjects edit moved off the markup to the untagged annotation', async () => {
    const { store, view, relId, psetId } = await reopenedWithForeign();
    view.setAttribute(relId, 'RelatedObjects', '#9004');

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    const saved = exportStep(store);
    assertKept(saved, relId, psetId, 9004);
    assert.match(saved, new RegExp(`^#${relId}=IFCRELDEFINESBYPROPERTIES\\([^;]*,#9004,#${psetId}\\);`, 'm'));
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('still matches an absorbed annotation whose GlobalId has a pending session edit', async () => {
    const { store, view, markupId } = await reopenedWithForeign();
    view.setAttribute(markupId, 'GlobalId', '3edited0GlobalId0000000');

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    assert.doesNotMatch(exportStep(store), new RegExp(`^#${markupId}=`, 'm'));
  });

  it('removes a relationship a named RelatedObjects edit moved from the untagged annotation onto the markup', async () => {
    const { store, view, markupId, relId, psetId } = await reopenedWithForeign();
    view.setAttribute(9005, 'RelatedObjects', `#${markupId}`);

    assert.equal(saveDrawingMarkupToModel('m1', NO_MARKUP).previousRemoved, 1);
    const saved = exportStep(store);
    for (const id of [relId, psetId, 9005, 9006, 9007]) {
      assert.doesNotMatch(saved, new RegExp(`^#${id}=`, 'm'), `#${id} related only the removed markup`);
    }
    assertKept(saved, 9004);
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
    assert.ok(saved.includes(`'${embedded}'`), 'the embedded measurement survives the save');
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
    assert.ok(!saved.includes(`'${guids.get('IfcLite:Markup:Measure')}'`));
    for (const tag of ['IfcLite:Markup:PolygonArea', 'IfcLite:Markup:Text', 'IfcLite:Markup:Cloud']) {
      assert.ok(guids.get(tag), `expected ${tag} in the first file`);
      assert.ok(saved.includes(`'${guids.get(tag)}'`), `${tag} was never absorbed and must survive`);
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

/**
 * PR #10083 review: the session sweep, the embedded sweep and the replacement
 * write are one edit. A write that throws past `findInvalidMarkup`'s
 * pre-validation must leave the model exactly as it was, not with the swept
 * annotations gone and nothing written in their place.
 */
describe('saveDrawingMarkupToModel when the replacement write fails', () => {
  /** Run `save` with every entity creation throwing, the way an unforeseen writer failure would. */
  function withFailingWrite<T>(save: () => T): T {
    const failing = mock.method(StoreEditor.prototype, 'addEntity', () => { throw new Error('simulated writer failure'); });
    try {
      return save();
    } finally {
      failing.mock.restore();
    }
  }

  it('keeps the absorbed embedded markup', async () => {
    const { store } = await reopenedWith(EVERY_KIND);
    const before = exportStep(store);
    const version = useViewerStore.getState().mutationVersion;

    const outcome = withFailingWrite(() => saveDrawingMarkupToModel('m1', ONE_MEASURE));
    assert.equal(outcome.refusal, 'invalid-markup');
    assert.equal(outcome.previousRemoved, 0);
    assert.equal(useViewerStore.getState().mutationVersion, version, 'nothing was published');
    const stamped = (step: string) => step.replace(/^FILE_NAME\(.*$/m, '');
    assert.equal(stamped(exportStep(store)), stamped(before), 'the file the user would save is unchanged');
  });

  it('keeps the markup an earlier save this session wrote', async () => {
    const store = await open(MINI_IFC);
    assert.equal(saveDrawingMarkupToModel('m1', EVERY_KIND).refusal, null);
    const before = exportStep(store);

    const outcome = withFailingWrite(() => saveDrawingMarkupToModel('m1', ONE_MEASURE));
    assert.equal(outcome.refusal, 'invalid-markup');
    // The exporter mints the GlobalIds of this session's property sets afresh
    // on every export, and stamps the time; everything else must match.
    const stable = (step: string) => step.replace(/^FILE_NAME\(.*$/m, '').replace(/'[0-9A-Za-z_$]{22}'/g, "'<guid>'");
    assert.equal(stable(exportStep(store)), stable(before));
    assert.equal(count(before, 'IFCANNOTATION'), 4);
  });
});

/**
 * Embedded DIMENSIONS go through the same absorb-then-replace path as the
 * other kinds: a restore that applied a dimension records its identity
 * (`restoredEmbeddedMarkupIdentities`, from the `ifc-dimension-<expressId>`
 * id the reader assigns), so the next save replaces it. Without that, every
 * re-save of a reopened model wrote a second dimension beside the first.
 */
describe('saveDrawingMarkupToModel on a reopened model with an embedded dimension', () => {
  const DIM: Dimension2D = {
    id: 'dim-1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.6, orientation: 'aligned',
    plane: { axis: 'down', position: 1.5, flipped: false },
  };
  const withDimensions = (dims: Dimension2D[], base: SaveMarkupInput = NO_MARKUP): SaveMarkupInput => ({
    ...base, dimensions2D: dims.map((d) => dimensionSaveParams(d, { paperScale: 100 })),
  });
  const ONE_DIMENSION = withDimensions([DIM]);

  /** Every `=IFCTYPE(` in the file, counted per type. */
  function typeCounts(step: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of step.matchAll(/^#\d+=(IFC[A-Z0-9]+)\(/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    return counts;
  }

  /** The express id of the embedded dimension annotation in `step`. */
  function dimensionExpressId(step: string): number {
    const m = /^#(\d+)=IFCANNOTATION\([^;]*'IfcLite:Markup:Dimension'/m.exec(step);
    assert.ok(m, 'expected the tagged dimension in the saved file');
    return Number(m[1]);
  }

  /** What `useDrawingMarkupRestoreOnLoad` does when its read applies: absorb what it restored. */
  function restoreDimensions(step: string, base: SaveMarkupInput = NO_MARKUP): void {
    const restored = { ...DIM, id: `ifc-dimension-${dimensionExpressId(step)}` };
    absorbEmbeddedMarkup('m1', restoredEmbeddedMarkupIdentities('m1', {
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
      ...base, dimensions2D: [restored],
    } as never));
  }

  it('records the restored dimension as absorbed, by the GlobalId it was opened with', async () => {
    const { step } = await reopenedWith(ONE_DIMENSION, false);
    restoreDimensions(step);
    assert.deepEqual([...absorbedEmbeddedMarkupFor('m1')], [markupGuids(step).get('IfcLite:Markup:Dimension')]);
  });

  it('replaces the embedded dimension on re-save: exactly one dimension, no orphaned text or extent', async () => {
    const { store, step: firstFile } = await reopenedWith(ONE_DIMENSION, false);
    assert.equal(count(firstFile, 'IFCANNOTATION'), 1);
    assert.equal(count(firstFile, 'IFCTEXTLITERALWITHEXTENT'), 1);
    restoreDimensions(firstFile);

    const outcome = saveDrawingMarkupToModel('m1', ONE_DIMENSION);
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.dimensionsSaved, 1);
    assert.equal(outcome.previousRemoved, 1, 'the dimension embedded in the file is the one this save replaces');

    const secondFile = exportStep(store);
    assert.equal(count(secondFile, 'IFCANNOTATION'), 1);
    assert.equal((secondFile.match(/'IfcLite:Markup:Dimension'/g) ?? []).length, 1);
    assert.ok(!secondFile.includes(`'${markupGuids(firstFile).get('IfcLite:Markup:Dimension')}'`), 'the embedded copy is gone');
    assert.deepEqual(danglingRefs(secondFile), []);
    assert.deepEqual(typeCounts(secondFile), typeCounts(firstFile), 'same shape as after the first save, not plus orphans');

    // And again, after another reopen.
    const third = await open(secondFile);
    restoreDimensions(secondFile);
    assert.equal(saveDrawingMarkupToModel('m1', ONE_DIMENSION).previousRemoved, 1);
    const thirdFile = exportStep(third);
    assert.equal(count(thirdFile, 'IFCANNOTATION'), 1);
    assert.deepEqual(danglingRefs(thirdFile), []);
    assert.deepEqual(typeCounts(thirdFile), typeCounts(firstFile));
  });

  it('replaces a dimension restored beside every other kind', async () => {
    const everything = withDimensions([DIM], EVERY_KIND);
    const { store, step: firstFile } = await reopenedWith(everything, false);
    absorbAll(firstFile);
    assert.equal(absorbedEmbeddedMarkupFor('m1').size, 5);

    assert.equal(saveDrawingMarkupToModel('m1', everything).previousRemoved, 5);
    const secondFile = exportStep(store);
    assert.equal(count(secondFile, 'IFCANNOTATION'), 5);
    assert.deepEqual(danglingRefs(secondFile), []);
    assert.deepEqual(typeCounts(secondFile), typeCounts(firstFile));
  });

  it('clears an absorbed embedded dimension and everything only it used', async () => {
    const { store, step } = await reopenedWith(ONE_DIMENSION, false);
    restoreDimensions(step);

    const outcome = saveDrawingMarkupToModel('m1', NO_MARKUP);
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 1);
    const cleared = exportStep(store);
    assert.deepEqual(danglingRefs(cleared), []);
    assert.deepEqual(typeCounts(cleared), typeCounts(MINI_IFC), 'back to the bare model');
  });

  it('keeps an embedded dimension the session never absorbed, writing the new markup beside it', async () => {
    const { store, step } = await reopenedWith(ONE_DIMENSION, false);
    const embedded = markupGuids(step).get('IfcLite:Markup:Dimension');
    assert.ok(embedded);

    const outcome = saveDrawingMarkupToModel('m1', withDimensions([{ ...DIM, id: 'user-dim', offset: -0.4 }]));
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 0);
    const saved = exportStep(store);
    assert.equal((saved.match(/'IfcLite:Markup:Dimension'/g) ?? []).length, 2, 'the embedded dimension and the new one');
    assert.ok(saved.includes(`'${embedded}'`), 'the embedded dimension survives the save');
    assert.equal(count(saved, 'IFCTEXTLITERALWITHEXTENT'), 2);
    assert.deepEqual(danglingRefs(saved), []);

    // A clear with nothing absorbed leaves it as well.
    const cleared = saveDrawingMarkupToModel('m1', NO_MARKUP);
    assert.equal(cleared.previousRemoved, 1, 'only this session\'s own dimension');
    assert.ok(exportStep(store).includes(`'${embedded}'`));
  });
});
