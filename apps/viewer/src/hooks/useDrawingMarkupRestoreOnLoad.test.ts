/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `tryRestoreDrawingMarkup`'s "never overwrite" guard — the rule
 * `useDrawingMarkupRestoreOnLoad.ts`'s module doc adopts for the
 * double-restore question against PR #4159's (separate, in-flight)
 * localStorage restore: whichever source populates the flat markup arrays
 * FIRST wins, and this restore path backs off rather than clobbering it.
 *
 * Calls `tryRestoreDrawingMarkup` bare, never wrapped in `act()` — it is a
 * plain synchronous function called from a raw store subscription in
 * production (`useDrawingMarkupRestoreOnLoad`'s effect and
 * `subscribeToParseCache` callback), not a React event handler, so
 * `act()`'s early effect-flush would test different timing than production
 * actually runs.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests, ensureParseFor, getParseFor } from './symbolic-parse-cache.js';
import { tryRestoreDrawingMarkup, __resetDrawingMarkupRestoreForTests } from './useDrawingMarkupRestoreOnLoad.js';

const TAGGED_ANNOTATION_ID = 50;

function fixture(): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('markup-hook','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000d',#4,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#6=IFCUNITASSIGNMENT((#2));
#${TAGGED_ANNOTATION_ID}=IFCANNOTATION('0Annot000000000000050d',#4,'Measurement',$,'IfcLite:Markup:Measure',$,$);
#1100=IFCELEMENTQUANTITY('0Qto0000000000001100d',#4,'Qto_IfcLiteMarkup',$,$,(#1101));
#1101=IFCQUANTITYLENGTH('Distance',$,$,5.0);
#1120=IFCRELDEFINESBYPROPERTIES('0Rel0000000000001120d',#4,$,$,(#${TAGGED_ANNOTATION_ID}),#1100);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(fixture());
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

async function seedStore(modelId: string): Promise<IfcDataStore> {
  const store = await parse();
  const state = useViewerStore.getState();
  useViewerStore.setState({
    activeModelId: modelId,
    models: new Map([...state.models, [modelId, {
      id: modelId, name: 'hook.ifc', ifcDataStore: store, visible: true, loadedAt: 1,
    } as never]]),
    measure2DResults: [],
    polygonArea2DResults: [],
    textAnnotations2D: [],
    cloudAnnotations2D: [],
  } as never);
  return store;
}

/** One polyline owned by the tagged annotation, in the shape the WASM worker would reply with. */
function oneMeasureFlat(): ReturnType<typeof createEmptyFlatSymbolic> {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation'];
  f.polyPoints = Float32Array.from([0, 0, 3, 4]);
  f.polyStart = Uint32Array.from([0, 2]);
  f.polyOwner = Uint32Array.from([TAGGED_ANNOTATION_ID]);
  f.polyWorldY = Float32Array.from([NaN]);
  f.polyFlags = Uint8Array.from([0]);
  f.polyType = Uint16Array.from([0]);
  return f;
}

interface HeldWorker {
  postMessage(request: { id: number }): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Installs a fake worker that answers the NEXT request with `flat`, real production code (`parseSymbolicFlat`/`buildParseResult`) untouched otherwise — same technique `useSymbolicAnnotations.frameRace.test.ts` uses. Returns the restore function. */
function fakeWasmReplyWith(flat: ReturnType<typeof createEmptyFlatSymbolic>): () => void {
  let worker: HeldWorker | null = null;
  let request: { id: number } | null = null;
  const previous = __setOverlayWorkerFactoryForTest(() => {
    worker = { postMessage: (r) => { request = r; }, terminate() {}, onmessage: null };
    return worker as unknown as Worker;
  });
  return () => {
    const posted = request as { id: number } | null;
    const live = worker as HeldWorker | null;
    assert.ok(posted && live, 'the fake worker never received a request');
    live.onmessage?.({ data: { id: posted.id, ok: true, flat } });
    __setOverlayWorkerFactoryForTest(previous);
  };
}

describe('tryRestoreDrawingMarkup: never overwrites', () => {
  beforeEach(() => {
    __resetDrawingMarkupRestoreForTests();
    __resetSymbolicAnnotationsCacheForTests();
  });

  it('backs off when the markup fields are already populated (e.g. by a localStorage restore)', async () => {
    await seedStore('never-overwrite-1');
    const preExisting = [{ id: 'local-1', start: { x: 9, y: 9 }, end: { x: 1, y: 1 }, distance: 11.3 }];
    useViewerStore.setState({ measure2DResults: preExisting } as never);

    tryRestoreDrawingMarkup('never-overwrite-1');

    // Synchronous: `tryRestoreDrawingMarkup` checks emptiness before doing
    // any parse-cache work, so no await is needed to observe the backoff.
    assert.deepEqual(useViewerStore.getState().measure2DResults, preExisting);
  });

  it('does not retry a model it has already backed off for, even after the fields are cleared', async () => {
    const store = await seedStore('never-overwrite-2');
    useViewerStore.setState({ measure2DResults: [{ id: 'local-2', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, distance: 1.4 }] } as never);
    tryRestoreDrawingMarkup('never-overwrite-2'); // marks the model as attempted, without writing

    // Something else (e.g. the user deleting their markup) clears the
    // fields afterwards. Even though the model DOES carry embedded markup
    // this session hasn't restored, a model already marked "attempted"
    // must stay backed off — run-once, not "run until non-empty".
    useViewerStore.setState({ measure2DResults: [] } as never);
    tryRestoreDrawingMarkup('never-overwrite-2');
    // Give any (unexpected) in-flight parse a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(getParseFor(store), undefined, 'a model already marked attempted should not trigger a parse');
    assert.deepEqual(useViewerStore.getState().measure2DResults, []);
  });
});

describe('tryRestoreDrawingMarkup: populates from a model with tagged annotations', () => {
  beforeEach(() => {
    __resetDrawingMarkupRestoreForTests();
    __resetSymbolicAnnotationsCacheForTests();
  });

  it('restores the tagged Measure2DResult once the parse lands, and does not duplicate on a second call', async () => {
    const store = await seedStore('populate-1');

    // First call: nothing parsed yet — `tryRestoreDrawingMarkup` itself never
    // triggers a parse (only `useDrawingMarkupRestoreOnLoad`'s effect does,
    // via `ensureParseFor`), so it must return without writing or marking
    // the model as attempted, leaving it free to retry once the parse lands.
    tryRestoreDrawingMarkup('populate-1');
    assert.deepEqual(useViewerStore.getState().measure2DResults, []);

    // Simulate what the mounted hook's effect does: kick off the parse.
    const release = fakeWasmReplyWith(oneMeasureFlat());
    ensureParseFor([store]);
    // ensureParseFor's request-dispatch is itself async (a microtask), so
    // let it reach the fake worker before releasing the reply.
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(getParseFor(store), 'the parse should be cached by now');

    // A parse-cache notification (what `subscribeToParseCache` delivers in
    // production) re-invokes the restore; this time the fields are still
    // empty and the parse is ready, so it should write.
    tryRestoreDrawingMarkup('populate-1');

    const state = useViewerStore.getState();
    assert.equal(state.measure2DResults.length, 1);
    assert.equal(state.measure2DResults[0].distance, 5);

    // Calling it again (e.g. an unrelated federated-model parse notifying
    // every listener) must not duplicate or clobber what was just restored.
    tryRestoreDrawingMarkup('populate-1');
    assert.equal(useViewerStore.getState().measure2DResults.length, 1);
  });
});
