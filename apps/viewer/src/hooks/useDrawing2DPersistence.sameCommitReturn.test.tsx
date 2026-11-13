/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An activation that leaves and returns to the same model inside one React
 * commit (a bulk edit over federated models: `recordRun` activates each
 * model it records for, synchronously). The save subscription arms
 * `restoringModelId` on every `activeModelId` move, but the restore effect
 * that disarms it was keyed on the id alone, so A -> X -> A rendered as "no
 * change", the effect never ran, and every later save for A was dropped for
 * the rest of the session (implicit-state-machines persistence latch).
 */
import '@/test/setup-dom.js';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { useDrawing2DPersistence, hasPersistedMarkupEntryFor } from './useDrawing2DPersistence.js';
import { loadDrawing2DEntry, clearAllDrawing2DEntries } from '@/store/slices/drawing2DSlice.persistence.js';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { waitFor } from '@/test/render.js';
import { settle, trackDigests } from '@/test/settle.js';
import type { Measure2DResult } from '@/store/slices/drawing2DSlice.js';

const DEFAULTS = useViewerStore.getState().drawing2DDisplayOptions;

function sampleMeasure(id: string): Measure2DResult {
  return { id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 };
}

/** A minimal `FederatedModel` — only the fields this hook's restore path reads. */
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

// ─── Harness ────────────────────────────────────────────────────────────────

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

/**
 * Let the active model's restore settle. These stub records carry no
 * placement identity, so the hook derives one from the file's bytes (#7035):
 * a slice read and digests (SHA-256 over every 1 MiB chunk for the 4-5 MB
 * buffers below), which no fixed number of ticks or milliseconds bounds on a
 * loaded runner (an earlier fixed-tick version failed on CI: a save fired
 * before `hashCache` had resolved). Wait for the decision itself, then let
 * what it scheduled run out: `settle` counts only event-loop turns with no
 * digest in flight, so neither step has a wall-clock budget.
 */
async function flush(): Promise<void> {
  await waitFor(() => {
    const activeModelId = useViewerStore.getState().activeModelId;
    return !activeModelId || hasPersistedMarkupEntryFor(activeModelId) !== 'pending';
  }, 'the active model\'s restore decision');
  await act(() => settle('the restore\'s follow-up work'));
}

let restoreDigest: () => void = () => {};
before(() => { restoreDigest = trackDigests(); });
after(() => restoreDigest());

beforeEach(() => {
  clearAllDrawing2DEntries();
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


it('a same-commit A -> X -> A return keeps saving A\'s markup', async () => {
  const fileA = fileWithBytes(1, 'a.ifc');
  const hashA = (await placementSourceIdentity(fileA))!;
  useViewerStore.setState({ models: new Map([
    ['model-a', stubModel('model-a', fileA)], ['model-x', stubModel('model-x', fileWithBytes(77, 'x.ifc'))],
  ]) });
  await mount();
  await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
  await flush();
  await act(async () => { useViewerStore.setState({ measure2DResults: [sampleMeasure('before')] }); });
  assert.deepEqual(loadDrawing2DEntry(hashA, DEFAULTS)?.measure2DResults.map((m) => m.id), ['before']);

  // Both switches land before React renders: one commit sees `model-a` throughout.
  await act(async () => {
    useViewerStore.getState().setActiveModel('model-x');
    useViewerStore.getState().setActiveModel('model-a');
  });
  await flush();

  await act(async () => {
    useViewerStore.setState({ measure2DResults: [...useViewerStore.getState().measure2DResults, sampleMeasure('after')] });
  });
  assert.deepEqual(loadDrawing2DEntry(hashA, DEFAULTS)?.measure2DResults.map((m) => m.id), ['before', 'after'],
    'a measurement drawn after the return is saved');
});
