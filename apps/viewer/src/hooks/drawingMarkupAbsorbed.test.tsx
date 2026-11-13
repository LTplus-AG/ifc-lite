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

const USER_MEASURE = { id: 'user-1', start: { x: 1, y: 1 }, end: { x: 1, y: 3 }, distance: 2 };

async function parseFixture(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
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

/** A fake overlay worker whose reply is held until the returned function is called. */
function heldWasmReply(flat = oneMeasureFlat()): () => void {
  let worker: { onmessage: ((event: { data: unknown }) => void) | null } | null = null;
  let request: { id: number } | null = null;
  __setOverlayWorkerFactoryForTest(() => {
    const created = { postMessage: (r: { id: number }) => { request = r; }, terminate() {}, onmessage: null };
    worker = created;
    return created as unknown as Worker;
  });
  return () => {
    const posted = request as { id: number } | null;
    assert.ok(posted && worker, 'the fake worker never received a request');
    worker.onmessage?.({ data: { id: posted.id, ok: true, flat } });
  };
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
async function open(modelId: string, file: File): Promise<IfcDataStore> {
  const store = await parseFixture();
  useViewerStore.setState({ editEnabled: true, models: new Map([[modelId, modelFor(modelId, file, store)]]) } as never);
  await act(async () => { useViewerStore.getState().setActiveModel(modelId); });
  return store;
}

/** Press "save markup to model" with the session's markup, then export. */
function saveAndExport(modelId: string, store: IfcDataStore): string {
  const s = useViewerStore.getState();
  const outcome = saveDrawingMarkupToModel(modelId, {
    measure2DResults: s.measure2DResults, polygonArea2DResults: s.polygonArea2DResults,
    textAnnotations2D: s.textAnnotations2D, cloudAnnotations2D: s.cloudAnnotations2D,
  });
  assert.equal(outcome.refusal, null);
  const view = useViewerStore.getState().getMutationView(modelId);
  return new TextDecoder().decode(new StepExporter(store, view as never).export({ schema: 'IFC4', applyMutations: true }).content);
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
    assert.match(saved, /IFCQUANTITYLENGTH\('Distance',\$,\$,5\.\)/, 'the measurement is still in the file');
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
    const outcome = saveDrawingMarkupToModel('deleted', { measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [] });
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

  it('an entry written before the absorbed set existed sweeps nothing: the save writes beside the embedded markup', async () => {
    const file = fileWithBytes(59, 'old-entry.ifc');
    const hash = (await placementSourceIdentity(file))!;
    // Old format: no `absorbedEmbeddedMarkup` field at all.
    localStorage.setItem(`ifc-lite:drawing2d-markup:v1:${hash}`, JSON.stringify({
      measure2DResults: [{ id: `ifc-measure-${ANNOTATION_ID}`, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 }],
      polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
      drawing2DDisplayOptions: DEFAULTS, sectionConfig: null, savedAt: 1,
    }));
    assert.deepEqual(loadDrawing2DEntry(hash, DEFAULTS)?.absorbedEmbeddedMarkup, []);

    heldWasmReply();
    await mount();
    const store = await open('old-entry', file);
    await decided('old-entry');
    await waitFor(() => useViewerStore.getState().measure2DResults.length === 1, 'the old entry restores');
    assert.equal(absorbedEmbeddedMarkupFor('old-entry').size, 0);

    const saved = saveAndExport('old-entry', store);
    assert.equal(annotations(saved), 2, 'the embedded measurement is kept beside the re-saved one');
    assert.match(saved, new RegExp(`'${EMBEDDED_GUID}'`));
  });
});
