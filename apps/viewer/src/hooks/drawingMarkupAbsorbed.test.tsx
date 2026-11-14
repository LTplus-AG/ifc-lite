/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Save markup to model" replaces only embedded markup the session absorbed
 * (`drawing-markup-absorbed.ts`). These run the real restore hooks — the
 * localStorage restore (`useDrawing2DPersistence`) and the embedded restore
 * (`useDrawingMarkupRestoreOnLoad`) — then save, export through the real
 * `StepExporter` and count what the file holds.
 *
 * The first two are the review's traced data-loss paths: the embedded restore
 * did not run, and a save used to sweep the file's markup anyway.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { useDrawing2DPersistence, hasPersistedMarkupEntryFor } from './useDrawing2DPersistence.js';
import { useDrawingMarkupRestoreOnLoad, __resetDrawingMarkupRestoreForTests } from './useDrawingMarkupRestoreOnLoad.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests, getParseFor } from './symbolic-parse-cache.js';
import { waitFor } from '@/test/render.js';
import { loadDrawing2DEntry, saveDrawing2DEntry, clearAllDrawing2DEntries } from '@/store/slices/drawing2DSlice.persistence.js';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { saveDrawingMarkupToModel } from '@/lib/drawing2d-markup/drawing-markup-save';
import { __resetAbsorbedEmbeddedMarkupForTests, absorbedEmbeddedMarkupFor } from '@/lib/drawing2d-markup/drawing-markup-absorbed';

const DEFAULTS = getDefaultDrawing2DState().drawing2DDisplayOptions;
const ANNOTATION_ID = 50;
const EMBEDDED_GUID = '0Annot000000000000050d';

/** One embedded markup measurement (distance 5) on a model with a storey to anchor a save to. */
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('markup-absorbed','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000d',#4,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#6=IFCUNITASSIGNMENT((#2));
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#20=IFCLOCALPLACEMENT($,#8);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#${ANNOTATION_ID}=IFCANNOTATION('${EMBEDDED_GUID}',#4,'Measurement',$,'IfcLite:Markup:Measure',$,$);
#1100=IFCELEMENTQUANTITY('0Qto0000000000001100d',#4,'Qto_IfcLiteMarkup',$,$,(#1101));
#1101=IFCQUANTITYLENGTH('Distance',$,$,5.0);
#1120=IFCRELDEFINESBYPROPERTIES('0Rel0000000000001120d',#4,$,$,(#${ANNOTATION_ID}),#1100);
ENDSEC;
END-ISO-10303-21;
`;

const UNTAGGED_GUID = '0Annot000000000000060d';
/** {@link FIXTURE} plus an annotation another tool wrote, without an IfcLite markup tag. */
const UNTAGGED_FIXTURE = FIXTURE.replace('ENDSEC;\nEND-ISO', `#60=IFCANNOTATION('${UNTAGGED_GUID}',#4,'Note',$,'Other:Note',$,$);\nENDSEC;\nEND-ISO`);

const USER_MEASURE = { id: 'user-1', start: { x: 1, y: 1 }, end: { x: 1, y: 3 }, distance: 2 };

async function parseFixture(text = FIXTURE): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function fileWithBytes(seed: number, name: string): File {
  return new File([new Uint8Array(256).map((_, i) => (i + seed) % 256)], name, { type: 'application/octet-stream' });
}

function modelFor(id: string, file: File, store: IfcDataStore): FederatedModel {
  return {
    id, name: file.name, ifcDataStore: store, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: file.size, sourceFile: file, idOffset: 0, maxExpressId: 0,
  } as FederatedModel;
}

/** One polyline owned by the tagged annotation, as the WASM worker would reply. */
function oneMeasureFlat(): ReturnType<typeof createEmptyFlatSymbolic> {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation'];
  f.polyPoints = Float32Array.from([0, 0, 3, 4]);
  f.polyStart = Uint32Array.from([0, 2]);
  f.polyOwner = Uint32Array.from([ANNOTATION_ID]);
  f.polyWorldY = Float32Array.from([NaN]);
  f.polyFlags = Uint8Array.from([0]);
  f.polyType = Uint16Array.from([0]);
  return f;
}

/** Answers a reply a test left held, so a pending parse request cannot keep the test process alive. */
let releaseLeftover: (() => void) | null = null;

/** A fake overlay worker whose reply is held until the returned function is called. */
function heldWasmReply(flat = oneMeasureFlat()): () => void {
  let worker: { onmessage: ((event: { data: unknown }) => void) | null } | null = null;
  let request: { id: number } | null = null;
  __setOverlayWorkerFactoryForTest(() => {
    const created = { postMessage: (r: { id: number }) => { request = r; }, terminate() {}, onmessage: null };
    worker = created;
    return created as unknown as Worker;
  });
  const reply = () => {
    const posted = request as { id: number } | null;
    request = null;
    if (posted) worker?.onmessage?.({ data: { id: posted.id, ok: true, flat } });
    return posted !== null;
  };
  releaseLeftover = reply;
  return () => assert.ok(reply(), 'the fake worker never received a request');
}

function Probe(): null {
  useDrawing2DPersistence();
  useDrawingMarkupRestoreOnLoad();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
}

async function unmount(): Promise<void> {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) { container.remove(); container = null; }
}

/** Open `file` as `modelId` with a freshly parsed store, the way loading a file does. */
async function open(modelId: string, file: File, text = FIXTURE): Promise<IfcDataStore> {
  const store = await parseFixture(text);
  useViewerStore.setState({ editEnabled: true, models: new Map([[modelId, modelFor(modelId, file, store)]]) } as never);
  await act(async () => { useViewerStore.getState().setActiveModel(modelId); });
  return store;
}

/** Press "save markup to model" with the session's markup, then export. */
function saveAndExport(modelId: string, store: IfcDataStore): string {
  const s = useViewerStore.getState();
  const outcome = saveDrawingMarkupToModel(modelId, {
    measure2DResults: s.measure2DResults, polygonArea2DResults: s.polygonArea2DResults,
    textAnnotations2D: s.textAnnotations2D, cloudAnnotations2D: s.cloudAnnotations2D, dimensions2D: [],
  });
  assert.equal(outcome.refusal, null);
  const view = useViewerStore.getState().getMutationView(modelId);
  return new TextDecoder().decode(new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true }).content);
}

/** A measurement the embedded reader would have restored from annotation `expressId`. */
const embeddedOriginMeasure = (expressId: number) => ({ id: `ifc-measure-${expressId}`, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 });

/** Write an entry the way a viewer before #10083 did; `absorbed` adds the field a newer viewer writes. */
function writeOldEntry(hash: string, measures: unknown[], texts: unknown[] = [], absorbed?: string[]): void {
  localStorage.setItem(`ifc-lite:drawing2d-markup:v1:${hash}`, JSON.stringify({
    measure2DResults: measures, polygonArea2DResults: [], textAnnotations2D: texts, cloudAnnotations2D: [],
    drawing2DDisplayOptions: DEFAULTS, sectionConfig: null, savedAt: 1,
    ...(absorbed ? { absorbedEmbeddedMarkup: absorbed } : {}),
  }));
}

/** `#N` references in the exported file that no record defines. */
function danglingRefs(step: string): number[] {
  const data = step.slice(step.indexOf('DATA;'));
  const defined = new Set([...data.matchAll(/^#(\d+)\s*=/gm)].map((m) => Number(m[1])));
  const bodies = data.replace(/^#\d+\s*=/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  return [...new Set([...bodies.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].filter((id) => !defined.has(id));
}

const annotations = (step: string) => (step.match(/=IFCANNOTATION\(/g) ?? []).length;
const decided = (modelId: string) => waitFor(() => hasPersistedMarkupEntryFor(modelId) !== 'pending', "localStorage's restore decision");

beforeEach(() => {
  clearAllDrawing2DEntries();
  __resetDrawingMarkupRestoreForTests();
  __resetAbsorbedEmbeddedMarkupForTests();
  __resetSymbolicAnnotationsCacheForTests();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
});

afterEach(async () => {
  const leftover = releaseLeftover;
  releaseLeftover = null;
  if (leftover) await act(async () => { leftover(); });
  await unmount();
  clearAllDrawing2DEntries();
});

describe('save markup to model keeps embedded markup the session never absorbed', () => {
  it('the user draws before the embedded restore lands: the save keeps the embedded measurement', async () => {
    const release = heldWasmReply();
    await mount();
    const store = await open('drew-first', fileWithBytes(41, 'drew-first.ifc'));
    await decided('drew-first');

    // The parse has not landed; the user draws. The restore then finds
    // populated fields and gives up for good.
    await act(async () => { useViewerStore.setState({ measure2DResults: [USER_MEASURE] }); });
    await act(async () => { release(); });
    await waitFor(() => getParseFor(store) !== undefined, 'the annotation parse lands');
    assert.deepEqual(useViewerStore.getState().measure2DResults, [USER_MEASURE], 'setup: the restore backed off');
    assert.equal(absorbedEmbeddedMarkupFor('drew-first').size, 0);

    const saved = saveAndExport('drew-first', store);
    assert.equal(annotations(saved), 2, 'the embedded measurement and the user\'s');
    assert.match(saved, new RegExp(`'${EMBEDDED_GUID}'`), 'the embedded measurement the user never saw survives');
  });

  it('an empty entry persisted mid-restore by a display-option change does not stop the restore, and the save keeps the markup', async () => {
    const file = fileWithBytes(43, 'display-change.ifc');
    const hash = (await placementSourceIdentity(file))!;
    const release = heldWasmReply();
    await mount();
    const store = await open('display-change', file);
    await decided('display-change');
    assert.equal(hasPersistedMarkupEntryFor('display-change'), false);

    // While the restore waits for its parse, a display option changes; the
    // save subscription writes an entry with empty markup lists.
    await act(async () => {
      useViewerStore.setState({ drawing2DDisplayOptions: { ...DEFAULTS, showHatching: !DEFAULTS.showHatching } });
    });
    assert.ok(loadDrawing2DEntry(hash, DEFAULTS), 'setup: the empty entry was persisted');

    await act(async () => { release(); });
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the embedded restore still applies');
    assert.equal(useViewerStore.getState().measure2DResults[0].distance, 5);
    assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showHatching, !DEFAULTS.showHatching, 'the display change is kept');
    assert.deepEqual(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, [EMBEDDED_GUID], 'the entry is reseeded from the restore');

    const saved = saveAndExport('display-change', store);
    assert.equal(annotations(saved), 1, 'the absorbed measurement is replaced, not duplicated');
    assert.match(saved, /IFCQUANTITYLENGTH\('Distance',\$,\$,5\.,/, 'the measurement is still in the file');
  });

  // PR #10083 review: leaving while the parse is pending, and returning once
  // it is cached, must not let the empty entry win on the way back.
  it('an empty entry persisted mid-restore does not erase the markup when the user leaves and returns after the parse lands', async () => {
    const file = fileWithBytes(45, 'left-and-returned.ifc');
    const hash = (await placementSourceIdentity(file))!;
    const release = heldWasmReply();
    await mount();
    const store = await parseFixture();
    const other = fileWithBytes(46, 'other.ifc');
    useViewerStore.setState({
      editEnabled: true,
      models: new Map([
        ['returned', modelFor('returned', file, store)],
        ['other', { ...modelFor('other', other, store), ifcDataStore: null } as FederatedModel],
      ]),
    } as never);
    await act(async () => { useViewerStore.getState().setActiveModel('returned'); });
    await decided('returned');
    await act(async () => {
      useViewerStore.setState({ drawing2DDisplayOptions: { ...DEFAULTS, showHatching: !DEFAULTS.showHatching } });
    });
    assert.ok(loadDrawing2DEntry(hash, DEFAULTS), 'setup: the empty entry was persisted');

    // Leave before the parse lands; it lands while the other model is active.
    await act(async () => { useViewerStore.getState().setActiveModel('other'); });
    await decided('other');
    await act(async () => { release(); });
    await waitFor(() => getParseFor(store) !== undefined, 'the annotation parse lands');
    assert.equal(useViewerStore.getState().measure2DResults.length, 0, 'setup: nothing restored into the other model');

    // Return: the parse is cached, so the embedded restore can apply at once.
    await act(async () => { useViewerStore.getState().setActiveModel('returned'); });
    await waitFor(() => loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup?.length === 1, 'the entry is reseeded from the restore');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.equal(useViewerStore.getState().measure2DResults.length, 1, 'the embedded measurement is shown');
    assert.equal(useViewerStore.getState().measure2DResults[0].distance, 5);
    assert.deepEqual([...absorbedEmbeddedMarkupFor('returned')], [EMBEDDED_GUID]);
    assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showHatching, !DEFAULTS.showHatching, 'the display change is kept');

    const saved = saveAndExport('returned', store);
    assert.equal(annotations(saved), 1, 'the absorbed measurement is replaced, not duplicated or dropped');
    assert.match(saved, /IFCQUANTITYLENGTH\('Distance',\$,\$,5\.,/);
  });

  // PR #10083 review: a model without a File persists nothing, so leaving and
  // returning brings its markup back empty. The set absorbed on the first
  // visit must not survive that, or the save deletes what is off screen.
  it('a model without a File, left and returned: the save keeps the embedded markup no longer on screen', async () => {
    const release = heldWasmReply();
    await mount();
    const store = await parseFixture();
    const other = fileWithBytes(48, 'other.ifc');
    useViewerStore.setState({
      editEnabled: true,
      models: new Map([
        ['no-file', { ...modelFor('no-file', fileWithBytes(49, 'no-file.ifc'), store), sourceFile: undefined } as FederatedModel],
        ['other', { ...modelFor('other', other, store), ifcDataStore: null } as FederatedModel],
      ]),
    } as never);
    await act(async () => { useViewerStore.getState().setActiveModel('no-file'); });
    await decided('no-file');
    await act(async () => { release(); });
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the embedded restore applies');
    assert.deepEqual([...absorbedEmbeddedMarkupFor('no-file')], [EMBEDDED_GUID], 'setup: absorbed on the first visit');

    await act(async () => { useViewerStore.getState().setActiveModel('other'); });
    await decided('other');
    await act(async () => { useViewerStore.getState().setActiveModel('no-file'); });
    await decided('no-file');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.equal(useViewerStore.getState().measure2DResults.length, 0, 'setup: nothing restored on the return');
    assert.equal(absorbedEmbeddedMarkupFor('no-file').size, 0);

    await act(async () => { useViewerStore.setState({ measure2DResults: [USER_MEASURE] }); });
    const saved = saveAndExport('no-file', store);
    assert.equal(annotations(saved), 2, 'the embedded measurement and the user\'s');
    assert.match(saved, new RegExp(`'${EMBEDDED_GUID}'`), 'the embedded measurement no longer on screen survives');
  });

  it('an empty entry that records absorbed markup is a deliberate deletion and still wins', async () => {
    const file = fileWithBytes(47, 'deleted.ifc');
    const hash = (await placementSourceIdentity(file))!;
    saveDrawing2DEntry(hash, {
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
      drawing2DDisplayOptions: DEFAULTS, sectionConfig: null, absorbedEmbeddedMarkup: [EMBEDDED_GUID],
    });
    const release = heldWasmReply();
    await mount();
    const store = await open('deleted', file);
    await decided('deleted');
    assert.equal(hasPersistedMarkupEntryFor('deleted'), true);
    await act(async () => { release(); });
    await waitFor(() => getParseFor(store) !== undefined, 'the annotation parse lands');
    assert.deepEqual(useViewerStore.getState().measure2DResults, []);

    // The deletion is saved: clearing removes the absorbed embedded annotation.
    const outcome = saveDrawingMarkupToModel('deleted', {
      measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [], dimensions2D: [],
    });
    assert.equal(outcome.refusal, null);
    assert.equal(outcome.previousRemoved, 1);
  });
});

describe('reopening a file whose localStorage entry was seeded from its own embedded markup', () => {
  it('replaces the embedded markup instead of duplicating it', async () => {
    const bytesSeed = 53;
    const hash = (await placementSourceIdentity(fileWithBytes(bytesSeed, 'own-export.ifc')))!;

    // First session: no entry, the embedded restore applies and seeds one.
    const release = heldWasmReply();
    await mount();
    await open('own-export', fileWithBytes(bytesSeed, 'own-export.ifc'));
    await decided('own-export');
    await act(async () => { release(); });
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the embedded restore applies');
    const seeded = loadDrawing2DEntry(hash, DEFAULTS);
    assert.equal(seeded?.measure2DResults.length, 1);
    assert.deepEqual(seeded?.absorbedEmbeddedMarkup, [EMBEDDED_GUID]);
    await unmount();

    // Reopen the same bytes: the localStorage entry wins precedence, and its
    // absorbed set comes back with it.
    __resetDrawingMarkupRestoreForTests();
    __resetAbsorbedEmbeddedMarkupForTests();
    __resetSymbolicAnnotationsCacheForTests();
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels();
    heldWasmReply();
    await mount();
    const store = await open('own-export', fileWithBytes(bytesSeed, 'own-export.ifc'));
    await decided('own-export');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the localStorage entry restores');
    assert.deepEqual([...absorbedEmbeddedMarkupFor('own-export')], [EMBEDDED_GUID]);

    const saved = saveAndExport('own-export', store);
    assert.equal(annotations(saved), 1, 'one measurement, not the embedded copy plus the session\'s');
    assert.doesNotMatch(saved, new RegExp(`'${EMBEDDED_GUID}'`));
  });

  it('an entry written before the absorbed set existed absorbs its embedded-origin items: the save replaces, not duplicates', async () => {
    const file = fileWithBytes(59, 'old-entry.ifc');
    const hash = (await placementSourceIdentity(file))!;
    writeOldEntry(hash, [embeddedOriginMeasure(ANNOTATION_ID), USER_MEASURE]);
    assert.equal(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, undefined, 'setup: the field is absent, not empty');

    heldWasmReply();
    await mount();
    const store = await open('old-entry', file);
    await decided('old-entry');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 2, 'the old entry restores');
    assert.deepEqual([...absorbedEmbeddedMarkupFor('old-entry')], [EMBEDDED_GUID]);
    await waitFor(() => loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup !== undefined, 'the entry is saved again');
    assert.deepEqual(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, [EMBEDDED_GUID], 'the set is persisted as usual');

    const saved = saveAndExport('old-entry', store);
    assert.equal(annotations(saved), 2, 'the re-saved measurement and the user\'s; the embedded copy is replaced');
    assert.doesNotMatch(saved, new RegExp(`'${EMBEDDED_GUID}'`));
    assert.deepEqual(danglingRefs(saved), []);
  });

  for (const [label, identitySet] of [['records no set either', undefined], ['records an empty set', []]] as const) {
    it(`an entry from before the absorbed set, still under its pre-#7035 key, merged with an identity entry that ${label}, absorbs its embedded-origin items`, async () => {
      const modelId = identitySet ? 'old-key-empty-set' : 'old-key';
      const file = fileWithBytes(identitySet ? 66 : 65, 'old-key.ifc');
      const legacyKey = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
      writeOldEntry(legacyKey, [embeddedOriginMeasure(ANNOTATION_ID)]);
      writeOldEntry((await placementSourceIdentity(file))!, [USER_MEASURE], [], identitySet ? [...identitySet] : undefined);

      heldWasmReply();
      await mount();
      const store = await open(modelId, file);
      await decided(modelId);
      await waitFor(() => useViewerStore.getState().measure2DResults.length === 2, 'the merged entry restores');
      assert.deepEqual([...absorbedEmbeddedMarkupFor(modelId)], [EMBEDDED_GUID]);

      const saved = saveAndExport(modelId, store);
      assert.equal(annotations(saved), 2, 'the embedded copy is replaced');
      assert.deepEqual(danglingRefs(saved), []);
    });
  }

  // PR #10149 CodeRabbit: the merge must not record `[]` for an old entry it cannot read yet.
  it('a pre-#7035 entry merged while the parsed store is not attached keeps the old entry and absorbs once it is', async () => {
    const file = fileWithBytes(68, 'old-key-unreadable.ifc');
    const legacyKey = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
    const identity = (await placementSourceIdentity(file))!;
    writeOldEntry(legacyKey, [embeddedOriginMeasure(ANNOTATION_ID)]);
    writeOldEntry(identity, [USER_MEASURE], [], []);

    heldWasmReply();
    await mount();
    const store = await parseFixture();
    useViewerStore.setState({ editEnabled: true, models: new Map([['old-key-unreadable', { ...modelFor('old-key-unreadable', file, store), ifcDataStore: null } as FederatedModel]]) } as never);
    await act(async () => { useViewerStore.getState().setActiveModel('old-key-unreadable'); });
    await decided('old-key-unreadable');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 2, 'the merged markup is shown');
    assert.notEqual(localStorage.getItem(`ifc-lite:drawing2d:${legacyKey}`) ?? Object.keys(localStorage).find((k) => k.endsWith(legacyKey)), null,
      'the old entry is kept for a retry');
    assert.deepEqual(loadDrawing2DEntry(identity, DEFAULTS)?.absorbedEmbeddedMarkup ?? [], [], 'no set recording the old entry as empty-handed is written');
    assert.ok(Object.keys(localStorage).some((k) => k.endsWith(legacyKey)), 'the old entry is still stored');

    // The load attaches the store; the next activation retries the move.
    useViewerStore.setState({ models: new Map([['old-key-unreadable', modelFor('old-key-unreadable', file, store)]]) } as never);
    await act(async () => { useViewerStore.getState().setActiveModel(null as never); });
    await act(async () => { useViewerStore.getState().setActiveModel('old-key-unreadable'); });
    await decided('old-key-unreadable');
    await waitFor(() => absorbedEmbeddedMarkupFor('old-key-unreadable').has(EMBEDDED_GUID), 'the retried merge absorbs the old entry\'s item');
    const saved = saveAndExport('old-key-unreadable', store);
    assert.equal(annotations(saved), 2, 'the embedded copy is replaced, not duplicated');
    assert.deepEqual(danglingRefs(saved), []);
  });

  // PR #10149 bot review: the merged markup shown while the move waits must keep recorded sets.
  it('a waiting pre-#7035 merge keeps the identity entry\'s recorded absorbed set in effect', async () => {
    const file = fileWithBytes(69, 'old-key-recorded.ifc');
    const legacyKey = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
    writeOldEntry(legacyKey, [embeddedOriginMeasure(ANNOTATION_ID)]);
    // A deliberate deletion: the identity entry absorbed the embedded measurement and holds no copy of it.
    writeOldEntry((await placementSourceIdentity(file))!, [USER_MEASURE], [], [EMBEDDED_GUID]);

    heldWasmReply();
    await mount();
    const store = await parseFixture();
    useViewerStore.setState({ editEnabled: true, models: new Map([['old-key-recorded', { ...modelFor('old-key-recorded', file, store), ifcDataStore: null } as FederatedModel]]) } as never);
    await act(async () => { useViewerStore.getState().setActiveModel('old-key-recorded'); });
    await decided('old-key-recorded');
    await waitFor(() => useViewerStore.getState().measure2DResults.length >= 1, 'the merged markup is shown');
    assert.ok(absorbedEmbeddedMarkupFor('old-key-recorded').has(EMBEDDED_GUID), 'the recorded deletion stays in effect while the move waits');
  });

  // PR #10149 review: a restore can run before the parsed store is attached.
  it('an entry from before the absorbed set restored before the store is attached stays undecided, then absorbs once it is', async () => {
    const file = fileWithBytes(67, 'still-loading.ifc');
    const hash = (await placementSourceIdentity(file))!;
    writeOldEntry(hash, [embeddedOriginMeasure(ANNOTATION_ID)]);

    heldWasmReply();
    await mount();
    const store = await parseFixture();
    useViewerStore.setState({ editEnabled: true, models: new Map([['still-loading', { ...modelFor('still-loading', file, store), ifcDataStore: null } as FederatedModel]]) } as never);
    await act(async () => { useViewerStore.getState().setActiveModel('still-loading'); });
    await decided('still-loading');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the old entry restores');
    await act(async () => {
      useViewerStore.setState({ drawing2DDisplayOptions: { ...DEFAULTS, showHatching: !DEFAULTS.showHatching } });
    });
    await waitFor(() => loadDrawing2DEntry(hash, DEFAULTS)?.drawing2DDisplayOptions.showHatching === !DEFAULTS.showHatching, 'a save ran');
    assert.equal(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, undefined, 'no empty set is recorded while undecided');

    // The load attaches the store.
    useViewerStore.setState({ models: new Map([['still-loading', modelFor('still-loading', file, store)]]) } as never);
    assert.deepEqual([...absorbedEmbeddedMarkupFor('still-loading')], [EMBEDDED_GUID]);
    const saved = saveAndExport('still-loading', store);
    assert.equal(annotations(saved), 1, 'the embedded copy is replaced');
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('an entry written before the absorbed set existed absorbs nothing that is not a markup annotation of its kind in the file', async () => {
    const file = fileWithBytes(61, 'old-entry-other.ifc');
    const hash = (await placementSourceIdentity(file))!;
    // #30 is the storey, #60 an annotation without an IfcLite tag, #999 is not in the file,
    // and #50 is tagged as a measurement, not the text the `ifc-text-50` id names.
    const text = (id: string) => ({ id, position: { x: 2, y: 2 }, text: 'note', fontSize: 14, color: '#000000', backgroundColor: '#ffffff', borderColor: '#000000' });
    writeOldEntry(hash, [embeddedOriginMeasure(30), embeddedOriginMeasure(60), embeddedOriginMeasure(999)], [
      text('ifc-text-60'), text(`ifc-text-${ANNOTATION_ID}`),
    ]);

    heldWasmReply();
    await mount();
    const store = await open('old-entry-other', file, UNTAGGED_FIXTURE);
    await decided('old-entry-other');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 3, 'the old entry restores');
    assert.equal(useViewerStore.getState().textAnnotations2D.length, 2, 'setup: both texts restore');
    assert.equal(absorbedEmbeddedMarkupFor('old-entry-other').size, 0);
    await waitFor(() => loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup !== undefined, 'the entry is saved again');
    assert.deepEqual(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, []);

    const saved = saveAndExport('old-entry-other', store);
    assert.match(saved, new RegExp(`'${EMBEDDED_GUID}'`), 'the embedded measurement is kept');
    assert.match(saved, new RegExp(`'${UNTAGGED_GUID}'`), 'the untagged annotation is kept');
    assert.deepEqual(danglingRefs(saved), []);
  });

  it('an entry that records an empty absorbed set is not treated as an old one: its embedded-origin ids absorb nothing', async () => {
    const file = fileWithBytes(63, 'new-entry.ifc');
    const hash = (await placementSourceIdentity(file))!;
    writeOldEntry(hash, [embeddedOriginMeasure(ANNOTATION_ID)], [], []);

    heldWasmReply();
    await mount();
    const store = await open('new-entry', file);
    await decided('new-entry');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the entry restores');
    assert.equal(absorbedEmbeddedMarkupFor('new-entry').size, 0);

    const saved = saveAndExport('new-entry', store);
    assert.equal(annotations(saved), 2, 'the embedded measurement is kept beside the re-saved one');
    assert.match(saved, new RegExp(`'${EMBEDDED_GUID}'`));
  });
});
