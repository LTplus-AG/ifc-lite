/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Restore-on-load's viewer-specific wiring: `buildDrawingMarkupMetaLookup`
 * (surfacing `ObjectType`/`Qto_IfcLiteMarkup`/`Pset_IfcLiteMarkup` off a REAL
 * base file, through a `MutablePropertyView` configured the same way
 * `useZoneSpatialZones.ts`/`configureMutationView.ts` wire every other
 * authoring action) and `restoreDrawingMarkupFromModel`'s "not parsed yet"
 * contract.
 *
 * The geometry/quantity RECONSTRUCTION logic itself
 * (`readDrawingMarkupFromParseResult`) is already covered end-to-end in
 * `lib/overlay-parse/drawing-markup-read.test.ts` against the writer's real
 * output — this suite does not re-prove that. What is untested elsewhere is
 * the base-file property/quantity lookup this module adds: a model REOPENED
 * after being saved+exported has its markup's `ObjectType`/quantities as
 * base STEP data, not overlay data, and `drawing-markup-read.test.ts`'s own
 * fixtures are all overlay-authored. Hand-written base fixture below is
 * deliberate for that reason (same convention drawing-markup-read.test.ts's
 * own comment describes for its "hand-written-fixture" case).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { readDrawingMarkupFromParseResult } from '@/lib/overlay-parse/drawing-markup-read';
import { useViewerStore } from '@/store/index.js';
import { getDrawingMarkupModelContext } from './drawing-markup-context.js';
import { buildDrawingMarkupMetaLookup, restoreDrawingMarkupFromModel } from './drawing-markup-restore.js';

const TAGGED_ANNOTATION_ID = 50;
const UNTAGGED_ANNOTATION_ID = 60;

function fixture(): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('markup-restore','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',#4,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#6=IFCUNITASSIGNMENT((#2));
#${TAGGED_ANNOTATION_ID}=IFCANNOTATION('0Annot000000000000050a',#4,'Measurement',$,'IfcLite:Markup:Measure',$,$);
#1100=IFCELEMENTQUANTITY('0Qto0000000000001100a',#4,'Qto_IfcLiteMarkup',$,$,(#1101));
#1101=IFCQUANTITYLENGTH('Distance',$,$,5.0);
#1120=IFCRELDEFINESBYPROPERTIES('0Rel0000000000001120a',#4,$,$,(#${TAGGED_ANNOTATION_ID}),#1100);
#${UNTAGGED_ANNOTATION_ID}=IFCANNOTATION('0Annot000000000000060a',#4,'Plain sketch',$,$,$,$);
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

async function seedStore(modelId: string): Promise<IfcDataStore> {
  const store = await parse(fixture());
  const state = useViewerStore.getState();
  useViewerStore.setState({
    activeModelId: modelId,
    models: new Map([...state.models, [modelId, {
      id: modelId, name: 'restore.ifc', ifcDataStore: store, visible: true, loadedAt: 1,
    } as never]]),
    mutationViews: state.mutationViews,
    storeEditors: state.storeEditors,
  } as never);
  return store;
}

describe('buildDrawingMarkupMetaLookup: reading BASE (not overlay) file data', () => {
  it('surfaces a tagged IfcAnnotation\'s ObjectType and Qto_IfcLiteMarkup Distance', async () => {
    await seedStore('meta-1');
    const context = getDrawingMarkupModelContext('meta-1');
    assert.ok(context);
    const meta = buildDrawingMarkupMetaLookup(context.view, context.dataStore);

    const entry = meta(TAGGED_ANNOTATION_ID);
    assert.equal(entry?.objectType, 'IfcLite:Markup:Measure');
    assert.equal(entry?.quantities?.get('Distance'), 5);
  });

  it('reports null ObjectType (not an empty string) for an entity with none', async () => {
    await seedStore('meta-2');
    const context = getDrawingMarkupModelContext('meta-2');
    assert.ok(context);
    const meta = buildDrawingMarkupMetaLookup(context.view, context.dataStore);

    const entry = meta(UNTAGGED_ANNOTATION_ID);
    assert.equal(entry?.objectType, null);
    assert.equal(entry?.quantities?.size ?? 0, 0);
  });
});

describe('restoreDrawingMarkupFromModel + buildDrawingMarkupMetaLookup: end-to-end wiring', () => {
  it('rehydrates a Measure2DResult for the tagged annotation and skips the untagged one', async () => {
    await seedStore('wiring-1');
    const context = getDrawingMarkupModelContext('wiring-1');
    assert.ok(context);
    const meta = buildDrawingMarkupMetaLookup(context.view, context.dataStore);

    // Stands in for the symbolic-annotation parse (same convention
    // `drawing-markup-read.test.ts` documents — geometry is already in
    // metres by the time it reaches this reader). Both entities have real
    // segment geometry here on purpose: the untagged one must be skipped
    // because of its ObjectType, not because it lacks geometry.
    const parseResult = {
      byStorey: new Map(),
      loose: [
        { line: { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, category: 'annotation', ownerId: TAGGED_ANNOTATION_ID },
        { line: { start: { x: 10, y: 10 }, end: { x: 12, y: 10 } }, category: 'annotation', ownerId: UNTAGGED_ANNOTATION_ID },
      ],
      looseTexts: [],
      looseFills: [],
    };

    const result = readDrawingMarkupFromParseResult(parseResult, meta, {});
    assert.equal(result.measure2DResults.length, 1, 'the untagged annotation must not become markup');
    assert.equal(result.measure2DResults[0].distance, 5);
    assert.deepEqual(result.measure2DResults[0].start, { x: 0, y: 0 });
    assert.deepEqual(result.measure2DResults[0].end, { x: 3, y: 4 });
    assert.equal(result.polygonArea2DResults.length, 0);
    assert.equal(result.textAnnotations2D.length, 0);
    assert.equal(result.cloudAnnotations2D.length, 0);
  });

  it('a model with no tagged annotations at all restores nothing and does not throw', async () => {
    const store = await parse(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('plain','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000c',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`);
    const state = useViewerStore.getState();
    useViewerStore.setState({
      activeModelId: 'no-markup',
      models: new Map([...state.models, ['no-markup', {
        id: 'no-markup', name: 'plain.ifc', ifcDataStore: store, visible: true, loadedAt: 1,
      } as never]]),
    } as never);
    const context = getDrawingMarkupModelContext('no-markup');
    assert.ok(context);
    const meta = buildDrawingMarkupMetaLookup(context.view, context.dataStore);

    const result = readDrawingMarkupFromParseResult(
      { byStorey: new Map(), loose: [], looseTexts: [], looseFills: [] },
      meta,
      {},
    );
    assert.equal(result.measure2DResults.length, 0);
    assert.equal(result.polygonArea2DResults.length, 0);
    assert.equal(result.textAnnotations2D.length, 0);
    assert.equal(result.cloudAnnotations2D.length, 0);
  });
});

describe('restoreDrawingMarkupFromModel: not parsed yet', () => {
  it('returns null (never an empty result) before the symbolic-annotation parse has landed', async () => {
    await seedStore('unparsed-1');
    // Deliberately never calling `ensureParseFor` — `getParseFor` inside
    // `restoreDrawingMarkupFromModel` must find nothing cached for this
    // model's source and return `null`, distinct from "parsed but empty".
    const result = restoreDrawingMarkupFromModel('unparsed-1');
    assert.equal(result, null);
  });

  it('returns null for a model that is not loaded at all', () => {
    const result = restoreDrawingMarkupFromModel('never-loaded');
    assert.equal(result, null);
  });
});
