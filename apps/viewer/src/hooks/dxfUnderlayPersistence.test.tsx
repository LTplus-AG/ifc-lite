/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration coverage for `dxfUnderlaySave.ts`'s wiring into
 * `useDrawing2DPersistence.ts` (issue #4153, reopened): proves restore-on
 * -model-activate actually populates `dxfUnderlays`, and that a fast model
 * switch does not let a stale async IndexedDB lookup for the model just
 * switched AWAY FROM land on the newly active model's state. Mirrors
 * `useDrawing2DPersistence.test.tsx`'s harness (a `Probe` component + a real
 * React tree via `@/test/setup-dom.js`).
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice.js';
import { useDrawing2DPersistence } from './useDrawing2DPersistence.js';
import { clearAllDrawing2DEntries } from '@/store/slices/drawing2DSlice.persistence.js';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';

const DB_NAME = 'ifc-lite-drawing2d-dxf';
const STORE_DXF = 'dxf-underlays';

interface RawEntry {
  dxfUnderlays: DxfUnderlayState[];
  savedAt: number;
}

async function openTestDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_DXF)) {
        request.result.createObjectStore(STORE_DXF);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawPut(hash: string, dxfUnderlays: DxfUnderlayState[]): Promise<void> {
  const db = await openTestDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DXF, 'readwrite');
    tx.objectStore(STORE_DXF).put({ dxfUnderlays, savedAt: Date.now() }, hash);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function rawGet(hash: string): Promise<RawEntry | undefined> {
  const db = await openTestDb();
  const value = await new Promise<RawEntry | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_DXF, 'readonly');
    const request = tx.objectStore(STORE_DXF).get(hash);
    request.onsuccess = () => resolve(request.result as RawEntry | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function rawClear(): Promise<void> {
  const db = await openTestDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DXF, 'readwrite');
    tx.objectStore(STORE_DXF).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function stubModel(id: string, sourceFile: File): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: sourceFile.size,
    sourceFile,
    idOffset: 0,
    maxExpressId: 0,
  } as FederatedModel;
}

function fileWithBytes(seed: number, name: string): File {
  const bytes = new Uint8Array(256).map((_, i) => (i + seed) % 256);
  return new File([bytes], name, { type: 'application/octet-stream' });
}

function sampleUnderlay(id: string): DxfUnderlayState {
  return {
    id,
    name: 'plan.dxf',
    underlay: {
      name: 'plan.dxf',
      layers: [],
      bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
      unitScale: 1,
      skipped: {},
      warnings: [],
    },
    visible: true,
    visible3D: true,
    opacity: 1,
    layerVisibility: {},
    placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 },
    georeferenced: false,
  };
}

function Probe(): null {
  useDrawing2DPersistence();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

async function flushDeep(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  });
}

beforeEach(async () => {
  await rawClear();
  clearAllDrawing2DEntries();
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ dxfUnderlays: [] });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) { container.remove(); container = null; }
  clearAllDrawing2DEntries();
  await rawClear();
});

describe('dxfUnderlays restore on model activate', () => {
  it('populates dxfUnderlays from IndexedDB once the active model\'s hash resolves', async () => {
    const fileA = fileWithBytes(1, 'a.ifc');
    const hashA = (await placementSourceIdentity(fileA))!;
    await rawPut(hashA, [sampleUnderlay('saved-a')]);

    const modelA = stubModel('populate-model-a', fileA);
    useViewerStore.setState({ models: new Map([['populate-model-a', modelA]]) });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('populate-model-a'); });
    await flushDeep();

    const ids = useViewerStore.getState().dxfUnderlays.map((u) => u.id);
    assert.deepStrictEqual(ids, ['saved-a'], 'the saved underlay for this model\'s hash must be restored into the live store');
  });

  it('leaves dxfUnderlays untouched (not reset to []) when nothing was saved for the hash', async () => {
    const fileA = fileWithBytes(2, 'b.ifc');
    // Distinct model id from every other test in this file: `hashCache`
    // (`drawingMarkupRestorePrecedence.ts`) is module-level and keyed by
    // modelId, not content — reusing an id here would read back an earlier
    // test's cached hash for it instead of this test's own file.
    const modelA = stubModel('untouched-model-a', fileA);
    useViewerStore.setState({ models: new Map([['untouched-model-a', modelA]]), dxfUnderlays: [sampleUnderlay('preexisting')] });
    await mount();

    await act(async () => { useViewerStore.getState().setActiveModel('untouched-model-a'); });
    await flushDeep();

    const ids = useViewerStore.getState().dxfUnderlays.map((u) => u.id);
    assert.deepStrictEqual(ids, ['preexisting'], 'nothing saved for this hash must not clear or replace the live (preserved) dxfUnderlays');
  });

  it('does not add anything until the hash resolves — no premature restore', async () => {
    const fileA = fileWithBytes(3, 'c.ifc');
    const hashA = (await placementSourceIdentity(fileA))!;
    await rawPut(hashA, [sampleUnderlay('saved-c')]);

    const modelA = stubModel('premature-model-a', fileA);
    useViewerStore.setState({ models: new Map([['premature-model-a', modelA]]) });
    await mount();

    // Bare, not wrapped in act/flush: the hash+IDB lookup is async and has
    // not resolved yet at this synchronous point.
    useViewerStore.getState().setActiveModel('premature-model-a');
    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays, [], 'restore must not happen synchronously before the hash/IDB lookup resolves');

    // flushDeep, not flush: this restore chains a hash computation AND an
    // IndexedDB open+transaction, one more async hop than the localStorage
    // markup path flush()'s two ticks were tuned for.
    await flushDeep();
    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays.map((u) => u.id), ['saved-c']);
  });
});

// This describe exercises `useDrawing2DPersistence.ts`'s OUTER
// `stillCurrent()` guard (in `applyHash`, unmodified by this feature): a
// model switch during the HASH computation itself already stops `applyHash`
// from ever starting a restore for the stale model. The controlled slice
// read (the placement identity reads the file in slices, #7035) proves
// hashing has begun before the switch, so this
// cannot pass merely because the A effect never ran.
describe('dxfUnderlays restore — fast model switch during hash resolution (outer guard)', () => {
  it('a slow lookup for the model switched AWAY FROM must not land on the newly active model', async () => {
    const fileA = fileWithBytes(10, 'race-a.ifc');
    const fileB = fileWithBytes(11, 'race-b.ifc');
    const hashA = (await placementSourceIdentity(fileA))!;
    await rawPut(hashA, [sampleUnderlay('saved-a')]);

    const modelA = stubModel('race-model-a', fileA);
    const modelB = stubModel('race-model-b', fileB);
    useViewerStore.setState({ models: new Map([['race-model-a', modelA], ['race-model-b', modelB]]) });
    await mount();

    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    const originalSlice = fileA.slice.bind(fileA);
    Object.defineProperty(fileA, 'slice', {
      value: (start?: number, end?: number) => ({
        arrayBuffer: async () => {
          markReadStarted();
          await release;
          return originalSlice(start, end).arrayBuffer();
        },
      }),
    });

    // Do not switch until A's production hash read has definitely started.
    // Removing applyHash's outer stillCurrent guard then lets A restore here.
    useViewerStore.getState().setActiveModel('race-model-a');
    await readStarted;
    useViewerStore.getState().setActiveModel('race-model-b');
    releaseRead();

    // Let every pending microtask/timer (including A's now-stale lookup)
    // settle.
    await flushDeep();

    const ids = useViewerStore.getState().dxfUnderlays.map((u) => u.id);
    assert.ok(
      !ids.includes('saved-a'),
      `model A's saved underlay must never be applied once B is active (got: ${JSON.stringify(ids)})`,
    );
  });
});

describe('dxfUnderlays save while model hash is unresolved', () => {
  it('flushes the latest edit under the correct model hash after hashing settles', async () => {
    const fileA = fileWithBytes(20, 'pending-a.ifc');
    const expectedHash = (await placementSourceIdentity(fileA))!;
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    const originalSlice = fileA.slice.bind(fileA);
    Object.defineProperty(fileA, 'slice', {
      value: (start?: number, end?: number) => ({
        arrayBuffer: async () => {
          markReadStarted();
          await release;
          return originalSlice(start, end).arrayBuffer();
        },
      }),
    });

    const modelA = stubModel('pending-save-model-a', fileA);
    useViewerStore.setState({ models: new Map([['pending-save-model-a', modelA]]) });
    await mount();
    useViewerStore.getState().setActiveModel('pending-save-model-a');
    await readStarted;

    useViewerStore.setState({ dxfUnderlays: [sampleUnderlay('superseded-before-hash')] });
    useViewerStore.setState({ dxfUnderlays: [sampleUnderlay('latest-before-hash')] });
    releaseRead();
    await flushDeep();

    const saved = await rawGet(expectedHash);
    assert.deepStrictEqual(
      saved?.dxfUnderlays.map((u) => u.id),
      ['latest-before-hash'],
      'an edit made before hash resolution must be replayed to IndexedDB once the model hash is known',
    );
  });

  it('does not restore stale saved underlays over a removal when A is reactivated while hashing', async () => {
    const fileA = fileWithBytes(22, 'pending-removal.ifc');
    const fileB = fileWithBytes(23, 'pending-removal-b.ifc');
    const expectedHash = (await placementSourceIdentity(fileA))!;
    const old = sampleUnderlay('removed-before-hash');
    await rawPut(expectedHash, [old]);

    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    const originalSlice = fileA.slice.bind(fileA);
    Object.defineProperty(fileA, 'slice', {
      value: (start?: number, end?: number) => ({
        arrayBuffer: async () => {
          markReadStarted();
          await release;
          return originalSlice(start, end).arrayBuffer();
        },
      }),
    });

    const modelA = stubModel('pending-removal-model', fileA);
    const modelB = stubModel('pending-removal-model-b', fileB);
    useViewerStore.setState({
      models: new Map([[modelA.id, modelA], [modelB.id, modelB]]),
      dxfUnderlays: [old],
    });
    await mount();
    useViewerStore.getState().setActiveModel(modelA.id);
    await readStarted;
    useViewerStore.setState({ dxfUnderlays: [] });
    await act(async () => { useViewerStore.getState().setActiveModel(modelB.id); });
    await act(async () => { useViewerStore.getState().setActiveModel(modelA.id); });
    releaseRead();
    await flushDeep();

    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays, []);
    assert.deepStrictEqual((await rawGet(expectedHash))?.dxfUnderlays, []);
  });

  it('keeps unresolved edits isolated when models switch before either hash settles', async () => {
    const fileA = fileWithBytes(30, 'isolated-a.ifc');
    const fileB = fileWithBytes(31, 'isolated-b.ifc');
    const hashA = (await placementSourceIdentity(fileA))!;
    const hashB = (await placementSourceIdentity(fileB))!;

    const controls = new Map<File, { started: Promise<void>; release: () => void }>();
    for (const file of [fileA, fileB]) {
      let markStarted!: () => void;
      let releaseRead!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseRead = resolve; });
      const originalSlice = file.slice.bind(file);
      Object.defineProperty(file, 'slice', {
        value: (start?: number, end?: number) => ({
          arrayBuffer: async () => {
            markStarted();
            await release;
            return originalSlice(start, end).arrayBuffer();
          },
        }),
      });
      controls.set(file, { started, release: releaseRead });
    }

    const modelA = stubModel('isolated-model-a', fileA);
    const modelB = stubModel('isolated-model-b', fileB);
    useViewerStore.setState({ models: new Map([[modelA.id, modelA], [modelB.id, modelB]]) });
    await mount();

    useViewerStore.getState().setActiveModel(modelA.id);
    await controls.get(fileA)!.started;
    useViewerStore.setState({ dxfUnderlays: [sampleUnderlay('only-a')] });
    useViewerStore.getState().setActiveModel(modelB.id);
    await controls.get(fileB)!.started;
    useViewerStore.setState({ dxfUnderlays: [sampleUnderlay('only-b')] });

    controls.get(fileA)!.release();
    controls.get(fileB)!.release();
    await flushDeep();

    assert.deepStrictEqual((await rawGet(hashA))?.dxfUnderlays.map((u) => u.id), ['only-a']);
    assert.deepStrictEqual((await rawGet(hashB))?.dxfUnderlays.map((u) => u.id), ['only-b']);
  });

  it('deduplicates repeated ids inside one restored entry', async () => {
    const fileA = fileWithBytes(21, 'duplicate-a.ifc');
    const hashA = (await placementSourceIdentity(fileA))!;
    await rawPut(hashA, [sampleUnderlay('duplicate'), sampleUnderlay('duplicate')]);

    const modelA = stubModel('duplicate-model-a', fileA);
    useViewerStore.setState({ models: new Map([['duplicate-model-a', modelA]]) });
    await mount();
    useViewerStore.getState().setActiveModel('duplicate-model-a');
    await flushDeep();

    assert.deepStrictEqual(
      useViewerStore.getState().dxfUnderlays.map((u) => u.id),
      ['duplicate'],
    );
  });
});

// #7035: the key is the placement identity; an entry saved under the old key
// (a bare whole-file SHA-256, computed here by node:crypto) is moved to it.
describe('dxfUnderlays saved under the legacy whole-file key (#7035)', () => {
  /** A file, the key older viewers saved it under, and a count of whole-file reads. */
  async function legacyFixture(seed: number, name: string) {
    const file = fileWithBytes(seed, name);
    const legacy = createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex');
    const identity = (await placementSourceIdentity(file))!;
    const reads = { count: 0 };
    const read = file.arrayBuffer.bind(file);
    Object.defineProperty(file, 'arrayBuffer', { value: () => { reads.count += 1; return read(); } });
    return { file, legacy, identity, reads };
  }

  async function until(condition: () => Promise<boolean>, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await condition()) return;
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.fail(`timed out waiting for: ${label}`);
  }

  it('moves them to the identity key and restores them on that load', async () => {
    const { file, legacy, identity, reads } = await legacyFixture(60, 'legacy-dxf.ifc');
    await rawPut(legacy, [sampleUnderlay('legacy-u')]);
    useViewerStore.setState({ models: new Map([['legacy-dxf-model', stubModel('legacy-dxf-model', file)]]) });
    await mount();
    useViewerStore.getState().setActiveModel('legacy-dxf-model');
    await until(async () => (await rawGet(legacy)) === undefined, 'the legacy entry to be removed');

    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays.map((u) => u.id), ['legacy-u'], 'restored on the load that moves them');
    assert.deepStrictEqual((await rawGet(identity))?.dxfUnderlays.map((u) => u.id), ['legacy-u'], 'stored under the identity key');
    assert.equal(reads.count, 1, 'one whole-file pass found the legacy key');
  });

  it('adds them to what the identity key and the live session already hold, once each', async () => {
    const { file, legacy, identity } = await legacyFixture(61, 'merge-dxf.ifc');
    await rawPut(legacy, [sampleUnderlay('legacy-u'), sampleUnderlay('in-both')]);
    await rawPut(identity, [sampleUnderlay('in-both'), sampleUnderlay('identity-u')]);
    useViewerStore.setState({
      models: new Map([['merge-dxf-model', stubModel('merge-dxf-model', file)]]),
      dxfUnderlays: [sampleUnderlay('live-u')],
    });
    await mount();
    useViewerStore.getState().setActiveModel('merge-dxf-model');
    await until(async () => (await rawGet(legacy)) === undefined, 'the legacy entry to be removed');
    await flushDeep();

    const expected = ['identity-u', 'in-both', 'legacy-u', 'live-u'];
    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays.map((u) => u.id).sort(), expected);
    assert.deepStrictEqual((await rawGet(identity))?.dxfUnderlays.map((u) => u.id).sort(), expected);
  });

  it('never reads the whole file when no legacy key is stored', async () => {
    const { file, identity, reads } = await legacyFixture(62, 'no-legacy-dxf.ifc');
    await rawPut(identity, [sampleUnderlay('identity-u')]);
    useViewerStore.setState({ models: new Map([['no-legacy-dxf-model', stubModel('no-legacy-dxf-model', file)]]) });
    await mount();
    useViewerStore.getState().setActiveModel('no-legacy-dxf-model');
    await flushDeep();

    assert.deepStrictEqual(useViewerStore.getState().dxfUnderlays.map((u) => u.id), ['identity-u']);
    assert.equal(reads.count, 0);
  });
});
