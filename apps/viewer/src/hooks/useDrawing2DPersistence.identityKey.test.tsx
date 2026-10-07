/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7035: drawing persistence is keyed by the load's placement identity, and an
 * entry saved under the old key (a bare whole-file SHA-256) is moved to it.
 *
 * Every test drives the real `useDrawing2DPersistence` hook against the real
 * store and `localStorage`. Expected keys come from node:crypto, not from the
 * viewer's own hashing. A whole-file read is observed by wrapping the `File`'s
 * own `arrayBuffer` (the placement identity reads 1 MiB slices instead), and
 * the legacy pass by its own counter, `hash.drawingLegacyKey`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { perfCounters } from '@ifc-lite/load-trace';
import type { DrawingSheet, SectionConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import type { Measure2DResult } from '@/store/slices/drawing2DSlice.js';
import { keyFor, loadDrawing2DEntry, saveDrawing2DEntry } from '@/store/slices/drawing2DSlice.persistence.js';
import { sheetStorageKey } from '@/store/slices/sheetSlice.persistence';
import { identifyLoadedPlacementSource } from '@/lib/model-placement/loaded-source-identity';
import { hasPersistedMarkupEntryFor, useDrawing2DPersistence } from './useDrawing2DPersistence.js';

const MIB = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** The key every viewer before #7035 saved under. */
const legacyKeyOf = (bytes: Uint8Array) => sha256(bytes);
/** The placement identity's construction, computed independently. */
function identityOf(bytes: Uint8Array): string {
  const parts = [`placement-sha256-1m-v1:${bytes.byteLength}`];
  for (let start = 0; start < bytes.byteLength; start += MIB) parts.push(sha256(bytes.subarray(start, start + MIB)));
  return `placement-sha256-1m-v1:${sha256(parts.join(':'))}`;
}

const DEFAULTS = useViewerStore.getState().drawing2DDisplayOptions;
const CHECKED_LOCAL = 'ifc-lite:drawing2d-legacy-checked:v1:local';
const SECTION: SectionConfig = {
  plane: { axis: 'z', position: 3, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 100,
};

const measure = (id: string, distance = 5): Measure2DResult => ({ id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance });
const entryWith = (measures: Measure2DResult[], sectionConfig: SectionConfig | null = null) => ({
  measure2DResults: measures, polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
  drawing2DDisplayOptions: DEFAULTS, sectionConfig,
});
const bytesOf = (seed: number) => new Uint8Array(4096).map((_, i) => (i * 7 + seed) % 251);

let wholeFileReads = 0;
/** A `File` over `bytes` that counts every whole-file read. */
function sourceFile(bytes: Uint8Array, name = 'model.ifc'): File {
  const file = new File([bytes as BlobPart], name);
  const read = file.arrayBuffer.bind(file);
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: () => { wholeFileReads += 1; return read(); } });
  return file;
}

/** A record as the loader leaves it: finished, carrying its identity. */
function loadedModel(id: string, file: File, bytes: Uint8Array, patch: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id, name: file.name, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false, schemaVersion: 'IFC4',
    loadedAt: 0, fileSize: file.size, sourceFile: file, idOffset: 0, maxExpressId: 0,
    loadState: 'complete', sourceContentHash: identityOf(bytes), ...patch,
  } as FederatedModel;
}

function Probe(): null {
  useDrawing2DPersistence();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${label}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}
/** Give work that should NOT happen the time it would need to happen. */
async function settle(ms = 60): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** Open `model` as the only, active model and wait for its restore to settle. */
async function open(model: FederatedModel, waitForRestore = true): Promise<void> {
  await act(async () => {
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels();
    useViewerStore.setState({ models: new Map([[model.id, model]]) });
    useViewerStore.getState().setActiveModel(model.id);
  });
  if (waitForRestore) await waitFor(() => hasPersistedMarkupEntryFor(model.id) !== 'pending', `${model.id}'s restore to settle`);
}

const legacyPasses = () => perfCounters.read()['hash.drawingLegacyKey.count'] ?? 0;
const fullSourcePasses = () => perfCounters.read()['hash.fullSource.count'] ?? 0;
const liveMeasures = () => useViewerStore.getState().measure2DResults.map((m) => m.id).sort();
const storedMeasures = (key: string) => (loadDrawing2DEntry(key, DEFAULTS)?.measure2DResults ?? []).map((m) => m.id).sort();
const legacyShapedKeys = () => Object.keys(localStorage).filter((key) => /:v1:[0-9a-f]{64}$/.test(key));

beforeEach(async () => {
  localStorage.clear();
  wholeFileReads = 0;
  perfCounters.enable(); // what `?perfTrace=1` and the benchmark do; this file's process only
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  localStorage.clear();
});

describe('drawing persistence is keyed by the placement identity (#7035)', () => {
  it('new saves use the identity key, without a pass over the file', async () => {
    const bytes = bytesOf(1);
    const file = sourceFile(bytes);
    const before = { full: fullSourcePasses(), legacy: legacyPasses() };
    await open(loadedModel('m1', file, bytes));
    await act(async () => { useViewerStore.setState({ measure2DResults: [measure('drawn')] }); });

    assert.deepEqual(storedMeasures(identityOf(bytes)), ['drawn'], 'the markup is stored under the placement identity');
    assert.ok(localStorage.getItem(`ifc-lite:drawing2d-markup:v1:${identityOf(bytes)}`), 'under the versioned markup prefix');
    assert.deepEqual(legacyShapedKeys(), [], 'nothing is written under a bare 64-hex key');
    assert.equal(wholeFileReads, 0, 'the file is not read again to derive the key');
    assert.equal(fullSourcePasses() - before.full, 0, 'the key costs no full-source pass of its own');
    assert.equal(legacyPasses() - before.legacy, 0, 'with no legacy entry stored, the legacy key is never computed');
  });

  it('a record without an identity still persists, under the identity of its bytes', async () => {
    const bytes = bytesOf(2);
    const file = sourceFile(bytes);
    // No `sourceContentHash`, no `loadState`: a record that did not come from the loader.
    await open(loadedModel('m1', file, bytes, { sourceContentHash: undefined, loadState: undefined }));
    await act(async () => { useViewerStore.setState({ measure2DResults: [measure('drawn')] }); });

    assert.deepEqual(storedMeasures(identityOf(bytes)), ['drawn']);
    assert.equal(useViewerStore.getState().models.get('m1')?.sourceContentHash, identityOf(bytes), 'the record now carries the identity');
    assert.equal(wholeFileReads, 0, 'the identity reads slices, never the whole file at once');
  });

  it('the shared identity pass writes to a record re-created under the same id and File, without another pass', async () => {
    const bytes = bytesOf(4);
    const file = sourceFile(bytes);
    const bare = () => loadedModel('m1', file, bytes, { sourceContentHash: undefined, loadState: undefined });
    await open(bare());
    assert.equal(useViewerStore.getState().models.get('m1')?.sourceContentHash, identityOf(bytes), 'setup: the hook had the record identified');

    const before = fullSourcePasses();
    await act(async () => { useViewerStore.setState({ models: new Map([['m1', bare()]]) }); });
    assert.equal(useViewerStore.getState().models.get('m1')?.sourceContentHash, undefined, 'setup: the new record has no identity yet');
    await act(async () => { await identifyLoadedPlacementSource('m1', file); });
    assert.equal(useViewerStore.getState().models.get('m1')?.sourceContentHash, identityOf(bytes), 'a settled pass still identifies the record that holds the file now');
    assert.equal(fullSourcePasses() - before, 0, 'from the pass already made for this model and file');
  });

  it('a model still loading waits for the loader\'s identity instead of hashing', async () => {
    const bytes = bytesOf(3);
    const file = sourceFile(bytes);
    const before = fullSourcePasses();
    await open(loadedModel('m1', file, bytes, { sourceContentHash: undefined, loadState: 'streaming-geometry' }), false);
    await settle();
    assert.equal(hasPersistedMarkupEntryFor('m1'), 'pending', 'the restore waits for the load\'s own pass');
    assert.equal(fullSourcePasses() - before, 0, 'and starts no pass of its own');

    await act(async () => { useViewerStore.getState().updateModel('m1', { sourceContentHash: identityOf(bytes) }); });
    await waitFor(() => hasPersistedMarkupEntryFor('m1') !== 'pending', 'the restore to settle on the identity');
    await act(async () => { useViewerStore.setState({ measure2DResults: [measure('drawn')] }); });
    assert.deepEqual(storedMeasures(identityOf(bytes)), ['drawn']);
    assert.equal(fullSourcePasses() - before, 0);
  });
});

describe('markup saved under the legacy key is moved to the identity key (#7035)', () => {
  it('is found and migrated exactly once', async () => {
    const bytes = bytesOf(10);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('legacy-1'), measure('legacy-2')], SECTION));
    const before = legacyPasses();

    await open(loadedModel('first', sourceFile(bytes), bytes));
    assert.deepEqual(liveMeasures(), ['legacy-1', 'legacy-2'], 'the saved markup is restored on the load that migrates it');
    assert.deepEqual(storedMeasures(identityOf(bytes)), ['legacy-1', 'legacy-2'], 'and now lives under the identity key');
    assert.deepEqual(loadDrawing2DEntry(identityOf(bytes), DEFAULTS)?.sectionConfig, SECTION, 'with its section plane');
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(bytes))), null, 'the legacy entry is removed once the move is confirmed');
    assert.equal(legacyPasses() - before, 1, 'one whole-file pass found the legacy key');
    assert.equal(wholeFileReads, 1);

    // The same bytes opened again: a new File, a new model id.
    await open(loadedModel('second', sourceFile(bytes), bytes));
    assert.deepEqual(liveMeasures(), ['legacy-1', 'legacy-2'], 'the migrated markup is restored again, not duplicated');
    assert.equal(legacyPasses() - before, 1, 'the second load does not hash for a legacy key');
    assert.equal(wholeFileReads, 1, 'and does not read the whole file');
  });

  it('a legacy entry of another file costs this file one check, not one per load', async () => {
    const other = bytesOf(20), mine = bytesOf(21);
    saveDrawing2DEntry(legacyKeyOf(other), entryWith([measure('other-file')]));
    const before = legacyPasses();

    await open(loadedModel('first', sourceFile(mine), mine));
    assert.equal(legacyPasses() - before, 1, 'a legacy entry might be this file\'s, so its legacy key is computed once');
    assert.deepEqual(liveMeasures(), [], 'another file\'s markup is not restored here');
    assert.deepEqual(storedMeasures(legacyKeyOf(other)), ['other-file'], 'and stays where it is for its own file');

    await open(loadedModel('second', sourceFile(mine), mine));
    assert.equal(legacyPasses() - before, 1, 'the checked identity is remembered');
    assert.equal(wholeFileReads, 1);
  });

  it('a legacy entry written after the file was checked (a tab on the old viewer) is still moved', async () => {
    const other = bytesOf(22), mine = bytesOf(23);
    saveDrawing2DEntry(legacyKeyOf(other), entryWith([measure('other-file')]));
    saveDrawing2DEntry(legacyKeyOf(mine), entryWith([measure('legacy-1')]));
    const before = legacyPasses();
    await open(loadedModel('first', sourceFile(mine), mine));
    assert.deepEqual(liveMeasures(), ['legacy-1']);
    assert.equal(legacyPasses() - before, 1);

    // A tab that still runs the previous viewer saves under the legacy key again.
    saveDrawing2DEntry(legacyKeyOf(mine), entryWith([measure('drawn-in-old-viewer')]));
    await open(loadedModel('second', sourceFile(mine), mine));
    assert.deepEqual(liveMeasures(), ['drawn-in-old-viewer', 'legacy-1'], 'the late entry is united with the migrated one');
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(mine))), null);
    assert.equal(legacyPasses() - before, 2, 'a legacy key that was not there at the earlier check costs one more pass');

    await open(loadedModel('third', sourceFile(mine), mine));
    assert.equal(legacyPasses() - before, 2, 'and after that the file is not hashed again');
    assert.deepEqual(storedMeasures(legacyKeyOf(other)), ['other-file']);
  });

  it('is not hashed for before the model has finished loading, and keeps what is drawn meanwhile', async () => {
    const bytes = bytesOf(30);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('legacy-1')]));
    const before = legacyPasses();
    await open(loadedModel('m1', sourceFile(bytes), bytes, { loadState: 'streaming-geometry' }), false);
    await settle();
    assert.equal(legacyPasses() - before, 0, 'no legacy pass while the load is running');
    assert.equal(wholeFileReads, 0);
    assert.equal(hasPersistedMarkupEntryFor('m1'), 'pending', 'the restore decision waits for the move');

    // The user draws before the move has run.
    await act(async () => { useViewerStore.setState({ measure2DResults: [measure('drawn-meanwhile')] }); });
    await act(async () => { useViewerStore.getState().updateModel('m1', { loadState: 'complete' }); });
    await waitFor(() => hasPersistedMarkupEntryFor('m1') !== 'pending', 'the restore to settle after the move');

    assert.deepEqual(liveMeasures(), ['drawn-meanwhile', 'legacy-1'], 'the new markup and the legacy markup are both on screen');
    assert.deepEqual(storedMeasures(identityOf(bytes)), ['drawn-meanwhile', 'legacy-1'], 'and both are stored under the identity key');
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(bytes))), null);
    assert.equal(legacyPasses() - before, 1);
  });

  it('a failed write keeps the legacy entry, and the next load moves it', async () => {
    const bytes = bytesOf(40);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('legacy-1')]));
    const identityKey = keyFor(identityOf(bytes));
    const realSetItem = localStorage.setItem.bind(localStorage);
    const quota = mock.method(localStorage, 'setItem', (key: string, value: string) => {
      if (key === identityKey) throw new Error('simulated quota exceeded');
      realSetItem(key, value);
    });
    try {
      await open(loadedModel('first', sourceFile(bytes), bytes));
    } finally {
      quota.mock.restore();
    }
    assert.deepEqual(storedMeasures(legacyKeyOf(bytes)), ['legacy-1'], 'an unconfirmed move never removes the legacy entry');
    assert.ok(!(localStorage.getItem(CHECKED_LOCAL) ?? '').includes(identityOf(bytes)), 'and the file is not marked as checked');

    await open(loadedModel('second', sourceFile(bytes), bytes));
    assert.deepEqual(liveMeasures(), ['legacy-1']);
    assert.deepEqual(storedMeasures(identityOf(bytes)), ['legacy-1']);
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(bytes))), null);
  });

  it('a legacy entry that could not be removed is not recorded as checked, and the next load removes it', async () => {
    const bytes = bytesOf(41);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('legacy-1')]));
    const legacyStorageKey = keyFor(legacyKeyOf(bytes));
    const realRemoveItem = localStorage.removeItem.bind(localStorage);
    const stuck = mock.method(localStorage, 'removeItem', (key: string) => {
      if (key === legacyStorageKey) throw new Error('simulated removal failure');
      realRemoveItem(key);
    });
    const before = legacyPasses();
    try {
      await open(loadedModel('first', sourceFile(bytes), bytes));
    } finally {
      stuck.mock.restore();
    }
    assert.deepEqual(liveMeasures(), ['legacy-1'], 'the markup was moved and restored');
    assert.ok(localStorage.getItem(legacyStorageKey), 'setup: the legacy entry is still there');
    assert.ok(!(localStorage.getItem(CHECKED_LOCAL) ?? '').includes(identityOf(bytes)), 'so the file is not recorded as checked');

    await open(loadedModel('second', sourceFile(bytes), bytes));
    assert.equal(legacyPasses() - before, 2, 'the next load looks again');
    assert.equal(localStorage.getItem(legacyStorageKey), null, 'and removes the leftover');
    assert.deepEqual(liveMeasures(), ['legacy-1'], 'without duplicating what was already moved');
  });

  it('keeps the legacy entry when its section plane is all that is left to move and the write fails', async () => {
    const bytes = bytesOf(42);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('shared')], SECTION));
    saveDrawing2DEntry(identityOf(bytes), entryWith([measure('shared')])); // every item already there, no plane
    const identityKey = keyFor(identityOf(bytes));
    const realSetItem = localStorage.setItem.bind(localStorage);
    const quota = mock.method(localStorage, 'setItem', (key: string, value: string) => {
      if (key === identityKey) throw new Error('simulated quota exceeded');
      realSetItem(key, value);
    });
    try {
      await open(loadedModel('first', sourceFile(bytes), bytes));
    } finally {
      quota.mock.restore();
    }
    assert.deepEqual(loadDrawing2DEntry(legacyKeyOf(bytes), DEFAULTS)?.sectionConfig, SECTION, 'the only copy of the plane is not removed');

    await open(loadedModel('second', sourceFile(bytes), bytes));
    assert.deepEqual(loadDrawing2DEntry(identityOf(bytes), DEFAULTS)?.sectionConfig, SECTION, 'and the next load carries it over');
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(bytes))), null);
  });

  it('an interrupted move (both entries present) recovers without loss, duplication or older-over-newer', async () => {
    const bytes = bytesOf(50);
    // The tab closed after the identity entry was written and before the
    // legacy entry was removed; `shared` exists in both.
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('shared', 5), measure('legacy-only')], SECTION));
    saveDrawing2DEntry(identityOf(bytes), entryWith([measure('shared', 99), measure('identity-only')]));

    await open(loadedModel('m1', sourceFile(bytes), bytes));
    assert.deepEqual(liveMeasures(), ['identity-only', 'legacy-only', 'shared'], 'every item once');
    const stored = loadDrawing2DEntry(identityOf(bytes), DEFAULTS)!;
    assert.equal(stored.measure2DResults.length, 3);
    assert.equal(stored.measure2DResults.find((m) => m.id === 'shared')?.distance, 99, 'the identity-key item is the newer one and is kept');
    assert.deepEqual(stored.sectionConfig, SECTION, 'a value only the legacy entry has is carried over');
    assert.equal(localStorage.getItem(keyFor(legacyKeyOf(bytes))), null);
  });

  it('another tab that finished the move first leaves nothing to redo', async () => {
    const bytes = bytesOf(60);
    saveDrawing2DEntry(legacyKeyOf(bytes), entryWith([measure('legacy-1')]));
    await open(loadedModel('m1', sourceFile(bytes), bytes, { loadState: 'streaming-geometry' }), false);
    await settle();
    // The other tab: moved the entry, then the user drew there.
    saveDrawing2DEntry(identityOf(bytes), entryWith([measure('legacy-1'), measure('drawn-in-other-tab')]));
    localStorage.removeItem(keyFor(legacyKeyOf(bytes)));

    await act(async () => { useViewerStore.getState().updateModel('m1', { loadState: 'complete' }); });
    await waitFor(() => hasPersistedMarkupEntryFor('m1') !== 'pending', 'the restore to settle');
    assert.deepEqual(liveMeasures(), ['drawn-in-other-tab', 'legacy-1']);
    assert.deepEqual(storedMeasures(identityOf(bytes)), ['drawn-in-other-tab', 'legacy-1'], 'the other tab\'s entry is not overwritten');
  });

  it('a sheet saved under the legacy key is moved with it', async () => {
    const bytes = bytesOf(70);
    useViewerStore.getState().createSheet({ paperId: 'A4_PORTRAIT' });
    const sheet: DrawingSheet = useViewerStore.getState().activeSheet!;
    localStorage.setItem(sheetStorageKey(legacyKeyOf(bytes)), JSON.stringify({ sheet, savedAt: 1 }));

    await open(loadedModel('m1', sourceFile(bytes), bytes));
    await waitFor(() => useViewerStore.getState().activeSheet !== null, 'the sheet to be restored');
    assert.deepEqual(useViewerStore.getState().activeSheet, sheet);
    const moved = JSON.parse(localStorage.getItem(sheetStorageKey(identityOf(bytes)))!) as { sheet: DrawingSheet };
    assert.deepEqual(moved.sheet, sheet);
    assert.equal(localStorage.getItem(sheetStorageKey(legacyKeyOf(bytes))), null);
  });
});
