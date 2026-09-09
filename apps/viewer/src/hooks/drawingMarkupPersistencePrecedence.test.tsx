/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useDrawing2DPersistence` (#4159, localStorage) and
 * `useDrawingMarkupRestoreOnLoad` (#4170, IFC-embedded) both mount
 * unconditionally in `Section2DPanel.tsx` and both restore the SAME four
 * flat markup arrays. This file is the "both sources present at once" case
 * neither hook's own test file exercises — the gap that let #4170 ship with
 * an asymmetric guard (see both hooks' module docs for the full analysis).
 *
 * The scenario below is deliberately the one where "whichever source
 * populates first wins" and "localStorage is always authoritative" would
 * give the SAME wrong answer if the guard were merely "are the arrays
 * empty": a user who deleted all their local markup and had that (empty)
 * state saved to `localStorage`, reopening a file whose IFC bytes still
 * carry OLDER, already-superseded embedded markup. `useDrawing2DPersistence`
 * resolves first (its hash is cheap here) and writes `[]` — indistinguishable,
 * to a plain emptiness check, from "no source has run yet". The IFC restore
 * must not then resurrect the stale embedded markup on top of it.
 *
 * The SECOND test below covers the other ordering — the one an earlier
 * version of this file did NOT: the WASM parse landing while `#4159`'s hash
 * is STILL resolving. A fixture that lets the hash resolve on the very first
 * `flush()` (before the fake WASM worker is ever released) can never put the
 * restore through its `'pending'`-branch WAIT at all — mutating that branch
 * away passed anyway. `fileWithHeldHash` exists to make that ordering
 * deterministic rather than incidental.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { useDrawing2DPersistence } from './useDrawing2DPersistence.js';
import { useDrawingMarkupRestoreOnLoad, __resetDrawingMarkupRestoreForTests } from './useDrawingMarkupRestoreOnLoad.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests } from './symbolic-parse-cache.js';
import { loadDrawing2DEntry, saveDrawing2DEntry, clearAllDrawing2DEntries } from '@/store/slices/drawing2DSlice.persistence.js';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';
import { computeFullSourceHashFromBlob } from '@/utils/sourceContentHash.js';

const DEFAULTS = getDefaultDrawing2DState().drawing2DDisplayOptions;
const TAGGED_ANNOTATION_ID = 50;

/** An IFC fixture with ONE embedded markup measurement — same shape `useDrawingMarkupRestoreOnLoad.test.ts` uses. */
function fixture(): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('markup-precedence','',(''),(''),'','','');
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

async function parseFixture(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(fixture());
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function fileWithBytes(seed: number, name: string): File {
  const bytes = new Uint8Array(256).map((_, i) => (i + seed) % 256);
  return new File([bytes], name, { type: 'application/octet-stream' });
}

/**
 * A `File` whose `arrayBuffer()` — the step `computeFullSourceHashFromBlob`
 * awaits before it can hash anything — does not resolve until `release()` is
 * called. This is what lets a test hold #4159's hash computation at
 * `'pending'` on purpose, independent of how many ticks anything else takes,
 * so a scenario ("the IFC parse finishes before the hash resolves") that
 * would otherwise depend on incidental timing between a real SHA-256 digest
 * and a fake worker reply becomes deterministic instead. Deliberately does
 * NOT touch either hook under test — it only ever calls the SAME `File` API
 * (`arrayBuffer()`) `computeFullSourceHashFromBlob` already calls.
 */
function fileWithHeldHash(seed: number, name: string): { file: File; release: () => void } {
  const bytes = new Uint8Array(256).map((_, i) => (i + seed) % 256);
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const realArrayBuffer = file.arrayBuffer.bind(file);
  file.arrayBuffer = () => gate.then(realArrayBuffer);
  return { file, release: () => resolveGate() };
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

/** Installs a fake worker answering the NEXT request with `flat`. Returns a function that releases the reply. */
function fakeWasmReplyWith(flat: ReturnType<typeof createEmptyFlatSymbolic>): () => void {
  let worker: HeldWorker | null = null;
  let request: { id: number } | null = null;
  __setOverlayWorkerFactoryForTest(() => {
    worker = { postMessage: (r) => { request = r; }, terminate() {}, onmessage: null };
    return worker as unknown as Worker;
  });
  return () => {
    const posted = request as { id: number } | null;
    const live = worker as HeldWorker | null;
    assert.ok(posted && live, 'the fake worker never received a request');
    live.onmessage?.({ data: { id: posted.id, ok: true, flat } });
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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  clearAllDrawing2DEntries();
  __resetDrawingMarkupRestoreForTests();
  __resetSymbolicAnnotationsCacheForTests();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) { container.remove(); container = null; }
  clearAllDrawing2DEntries();
});

describe('localStorage (#4159) vs IFC-embedded (#4170) markup restore precedence', () => {
  it('does not resurrect stale IFC-embedded markup once localStorage has already resolved (even to an empty saved entry)', async () => {
    const file = fileWithBytes(7, 'both-sources.ifc');
    const hash = (await computeFullSourceHashFromBlob(file))!;
    const store = await parseFixture();
    const model: FederatedModel = {
      id: 'model-precedence',
      name: 'both-sources.ifc',
      ifcDataStore: store,
      geometryResult: null,
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: 0,
      fileSize: file.size,
      sourceFile: file,
      idOffset: 0,
      maxExpressId: 0,
    } as FederatedModel;

    // The user previously deleted all local markup for this exact file and
    // that state was saved — a REAL, deliberate entry, just an empty one.
    saveDrawing2DEntry(hash, {
      measure2DResults: [],
      polygonArea2DResults: [],
      textAnnotations2D: [],
      cloudAnnotations2D: [],
      drawing2DDisplayOptions: DEFAULTS,
      sectionConfig: null,
    });
    assert.ok(loadDrawing2DEntry(hash, DEFAULTS), 'setup sanity: the empty entry must actually be saved');

    useViewerStore.setState({ models: new Map([['model-precedence', model]]) });
    const release = fakeWasmReplyWith(oneMeasureFlat());

    await mount();
    await act(async () => { useViewerStore.getState().setActiveModel('model-precedence'); });

    // Let localStorage's restore resolve FIRST — its hash is a fast,
    // in-memory computation over a 256-byte file, well within these ticks.
    await flush();
    assert.deepEqual(
      useViewerStore.getState().measure2DResults,
      [],
      'setup sanity: localStorage\'s (empty) restore should have already resolved',
    );

    // NOW let the IFC-embedded restore's WASM parse land.
    await act(async () => { release(); });
    await flush();

    assert.deepEqual(
      useViewerStore.getState().measure2DResults,
      [],
      'a localStorage entry that already resolved (even an empty one) must win — the IFC\'s stale embedded markup must not resurface on top of it',
    );
  });

  it('waits for localStorage\'s decision when the IFC parse finishes FIRST, then restores once localStorage resolves to no saved entry', async () => {
    // The other ordering from the test above — and the one #4170 actually
    // shipped without covering (see this file's header doc): the WASM parse
    // lands while #4159's hash is STILL resolving. `held.release()` below is
    // what makes that ordering deterministic rather than incidental.
    const held = fileWithHeldHash(11, 'parse-before-hash.ifc');
    const store = await parseFixture();
    const model: FederatedModel = {
      id: 'model-precedence-2',
      name: 'parse-before-hash.ifc',
      ifcDataStore: store,
      geometryResult: null,
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: 0,
      fileSize: held.file.size,
      sourceFile: held.file,
      idOffset: 0,
      maxExpressId: 0,
    } as FederatedModel;

    useViewerStore.setState({ models: new Map([['model-precedence-2', model]]) });
    const release = fakeWasmReplyWith(oneMeasureFlat());

    await mount();
    await act(async () => { useViewerStore.getState().setActiveModel('model-precedence-2'); });

    // Let the IFC-embedded restore's WASM parse land FIRST — the hash's
    // `arrayBuffer()` is still gated by `held`, so `hasPersistedMarkupEntryFor`
    // must still be reporting `'pending'` at this point.
    await act(async () => { release(); });
    await flush();
    assert.deepEqual(
      useViewerStore.getState().measure2DResults,
      [],
      'the WASM parse finishing must not restore the IFC-embedded markup while localStorage\'s decision is still pending — it must wait',
    );

    // NOW let localStorage's hash resolve. No entry was ever saved for this
    // file, so the decision is "no saved entry" — the deferred IFC restore
    // may finally proceed.
    await act(async () => { held.release(); });
    await flush();
    const state = useViewerStore.getState();
    assert.equal(
      state.measure2DResults.length,
      1,
      'once localStorage resolves to "no saved entry", the deferred IFC-embedded restore must finally run',
    );
    assert.equal(state.measure2DResults[0].distance, 5);
  });
});
