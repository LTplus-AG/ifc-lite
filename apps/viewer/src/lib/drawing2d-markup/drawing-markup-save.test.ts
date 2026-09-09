/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The UI-facing "save markup into model" action: `saveDrawingMarkupToModel`
 * resolving a real model's anchor/root-context and writing through
 * `@ifc-lite/create`'s `addDrawingMarkupToStore`, plus idempotence
 * (`removeDrawingMarkupFromStore`'s sweep-and-replace) so pressing Save
 * twice does not duplicate.
 *
 * Real `IfcParser` fixture + `StepExporter`, same convention
 * `useZoneSpatialZones.test.ts` uses for its own overlay-authoring action:
 * asserting on the overlay proves the writer wrote what it meant to: the
 * exported FILE (re-parsed) proves it survives the round trip.
 *
 * Calls `saveDrawingMarkupToModel` bare — no `act()` — per the production-
 * timing requirement: this action runs from a plain button click handler,
 * synchronously, never wrapped in a React update batch.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';
import { useViewerStore } from '@/store/index.js';
import { saveDrawingMarkupToModel, type SaveMarkupInput } from './drawing-markup-save.js';

const STOREY_ID = 30;

function miniIfc(): string {
  return `ISO-10303-21;
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
}

async function parse(ifc: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

async function seedStore(): Promise<IfcDataStore> {
  const store = await parse(miniIfc());
  useViewerStore.setState({
    activeModelId: 'm1',
    models: new Map([['m1', {
      id: 'm1',
      name: 'markup.ifc',
      ifcDataStore: store,
      visible: true,
      loadedAt: 1,
    } as never]]),
    mutationViews: new Map(),
    storeEditors: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
  } as never);
  return store;
}

function overlay() {
  return useViewerStore.getState().getMutationView('m1')?.getNewEntities() ?? [];
}

function annotationEntities() {
  return overlay().filter((e) => e.type === 'IfcAnnotation');
}

function exportStep(store: IfcDataStore): string {
  const view = useViewerStore.getState().getMutationView('m1');
  const result = new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

const ONE_MEASURE: SaveMarkupInput = {
  measure2DResults: [{ id: 'meas-1', start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
  polygonArea2DResults: [],
  textAnnotations2D: [],
  cloudAnnotations2D: [],
};

/** A cloud restored from a hand-edited/malformed IFC file: `fill.rs`'s
 *  `IfcAnnotationFillArea` boundary-ring path has no `is_finite()` guard, so
 *  an out-of-range STEP REAL (e.g. `1.E400`) on one corner survives the WASM
 *  boundary as `Infinity` and reaches `Drawing2DState.cloudAnnotations2D`
 *  unfiltered — this is that shape, not a synthetic one. */
const INVALID_CLOUD: SaveMarkupInput = {
  measure2DResults: [],
  polygonArea2DResults: [],
  textAnnotations2D: [],
  cloudAnnotations2D: [{
    id: 'cloud-bad',
    points: [{ x: 0, y: 0 }, { x: Infinity, y: 4 }],
    label: 'Note',
  }],
};

describe('saveDrawingMarkupToModel: what reaches the overlay', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('writes one tagged IfcAnnotation per markup item, and marks the model dirty', () => {
    const before = useViewerStore.getState().mutationVersion;
    const outcome = saveDrawingMarkupToModel('m1', ONE_MEASURE);

    assert.equal(outcome.refusal, null);
    assert.equal(outcome.measuresSaved, 1);
    assert.equal(outcome.previousRemoved, 0);

    const annotations = annotationEntities();
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].attributes[4], DRAWING_MARKUP_OBJECTTYPE.MEASURE);

    assert.ok(useViewerStore.getState().mutationVersion > before, 'markModelsDirty should bump mutationVersion');
    assert.ok(useViewerStore.getState().dirtyModels.has('m1'));
  });

  it('the exported FILE carries the tagged annotation and its Distance quantity', () => {
    saveDrawingMarkupToModel('m1', ONE_MEASURE);
    const step = exportStep(store);
    assert.match(step, /=IFCANNOTATION\('.{22}',#4,'Measurement',\$,'IfcLite:Markup:Measure',#\d+,#\d+\);/);
    assert.match(step, /Distance/);
  });

  it('refuses with nothing-to-save when there is nothing to write and nothing to clear', () => {
    const outcome = saveDrawingMarkupToModel('m1', {
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    });
    assert.equal(outcome.refusal, 'nothing-to-save');
    assert.equal(annotationEntities().length, 0);
  });
});

describe('saveDrawingMarkupToModel: pressing Save twice', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('replaces the previous save rather than stacking a second copy', () => {
    saveDrawingMarkupToModel('m1', ONE_MEASURE);
    const firstCount = annotationEntities().length;
    assert.equal(firstCount, 1);

    const second = saveDrawingMarkupToModel('m1', ONE_MEASURE);
    assert.equal(second.refusal, null);
    assert.equal(second.previousRemoved, 1, 'the earlier save\'s annotation should have been swept first');
    assert.equal(second.measuresSaved, 1);

    // Still exactly one copy in the overlay, and in the exported file.
    assert.equal(annotationEntities().length, 1);
    const step = exportStep(store);
    assert.equal((step.match(/=IFCANNOTATION\(/g) ?? []).length, 1);
  });

  it('clearing all markup and saving again removes the previously-saved annotation, not adds an empty batch', () => {
    saveDrawingMarkupToModel('m1', ONE_MEASURE);
    assert.equal(annotationEntities().length, 1);

    const outcome = saveDrawingMarkupToModel('m1', {
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
    });
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 1);
    assert.equal(annotationEntities().length, 0);
  });
});

describe('saveDrawingMarkupToModel: refusals', () => {
  it('refuses when the model is not loaded', () => {
    useViewerStore.setState({
      activeModelId: null,
      models: new Map(),
      mutationViews: new Map(),
      storeEditors: new Map(),
    } as never);
    const outcome = saveDrawingMarkupToModel('missing', ONE_MEASURE);
    assert.equal(outcome.refusal, 'no-model');
  });

  it('refuses when the model has no storey to anchor against', async () => {
    const store = await parse(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('empty','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000b',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`);
    useViewerStore.setState({
      activeModelId: 'm2',
      models: new Map([['m2', { id: 'm2', name: 'empty.ifc', ifcDataStore: store, visible: true, loadedAt: 1 } as never]]),
      mutationViews: new Map(),
      storeEditors: new Map(),
    } as never);
    const outcome = saveDrawingMarkupToModel('m2', ONE_MEASURE);
    assert.equal(outcome.refusal, 'no-anchor');
  });
});

/**
 * `#4160` (PR, the write side) added `assertFinitePoint`/
 * `assertFiniteNonNegative` to `@ifc-lite/create`'s `drawing-markup.ts`:
 * a NaN/Infinity coordinate that used to write malformed STEP now throws
 * instead. Before this suite's fix, `saveDrawingMarkupToModel` called
 * `addDrawingMarkupToStore` with no try/catch, so that throw propagated out
 * of a plain button click handler as an unhandled exception — and worse,
 * it fired AFTER `removeDrawingMarkupFromStore`'s sweep had already deleted
 * the previous save, so a rejected save destroyed the last good one too.
 * These calls this test drives bare (no `act()`), matching the production
 * click-handler timing — synchronous, not batched — this whole file's own
 * top-of-file comment documents that requirement for.
 */
describe('saveDrawingMarkupToModel: non-finite markup (the #4160 guard reaching this path)', () => {
  let store: IfcDataStore;
  beforeEach(async () => {
    store = await seedStore();
  });

  it('refuses cleanly instead of throwing when a markup point is non-finite', () => {
    const outcome = saveDrawingMarkupToModel('m1', INVALID_CLOUD);
    assert.equal(outcome.refusal, 'invalid-markup');
  });

  it('leaves no orphaned overlay entities from a rejected save', () => {
    const before = overlay().length;
    saveDrawingMarkupToModel('m1', INVALID_CLOUD);
    assert.equal(overlay().length, before, 'a rejected save must not add anything to the overlay');
  });

  it('does not mark the model dirty on a rejected save', () => {
    const beforeVersion = useViewerStore.getState().mutationVersion;
    saveDrawingMarkupToModel('m1', INVALID_CLOUD);
    assert.equal(useViewerStore.getState().mutationVersion, beforeVersion);
  });

  it('does not destroy a previous successful save when the next save is invalid', () => {
    saveDrawingMarkupToModel('m1', ONE_MEASURE);
    assert.equal(annotationEntities().length, 1);

    const outcome = saveDrawingMarkupToModel('m1', INVALID_CLOUD);
    assert.equal(outcome.refusal, 'invalid-markup');
    assert.equal(annotationEntities().length, 1, "the earlier save's annotation must survive a rejected next save");

    const step = exportStep(store);
    assert.equal((step.match(/=IFCANNOTATION\(/g) ?? []).length, 1);
  });
});
