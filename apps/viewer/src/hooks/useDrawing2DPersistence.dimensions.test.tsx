/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dimensions through the real auto-save and restore path: the save
 * subscription writes them into the model's entry beside the other markup,
 * and a reload of the same file restores them into the store.
 *
 * MUTATION TARGETS: drop `dimensions2D` from `persistFor` or from the change
 * check in `drawingMarkupSave.ts` and the saved-entry assertion fails; drop it
 * from the restore patch in `useDrawing2DPersistence.ts` and the restored-store
 * assertion fails.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
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
import type { Dimension2D } from '@/store/slices/drawing2DDimensions.js';

const DEFAULTS = useViewerStore.getState().drawing2DDisplayOptions;

const dimension: Dimension2D = {
  id: 'dim-keep', a: { x: 0, y: 0 }, b: { x: 4.2624, y: 0 }, offset: 0.5, orientation: 'aligned',
  plane: { axis: 'down', position: 42, flipped: false },
};

function stubModel(id: string, sourceFile: File): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: sourceFile.size, sourceFile, idOffset: 0, maxExpressId: 0,
  } as FederatedModel;
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
  await act(async () => { root!.render(<Probe />); });
}

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

describe('dimension auto-save and restore', () => {
  it('saves a placed dimension into the model\'s entry and restores it after a reload', async () => {
    const file = new File([new Uint8Array(256).map((_, i) => (i * 7) % 256)], 'a.ifc');
    const hash = (await placementSourceIdentity(file))!;

    useViewerStore.setState({ models: new Map([['model-a', stubModel('model-a', file)]]) });
    await mount();
    await act(async () => { useViewerStore.getState().setActiveModel('model-a'); });
    await flush();

    await act(async () => { useViewerStore.getState().addDimension2D(dimension); });
    const saved = loadDrawing2DEntry(hash, DEFAULTS);
    assert.ok(saved, 'placing a dimension saves the model\'s entry');
    assert.deepEqual(saved.dimensions2D?.map((d) => d.id), ['dim-keep'], 'the saved entry holds the dimension');

    // Reload: the load path resets, then the same file comes back as a fresh model.
    await act(async () => {
      useViewerStore.getState().resetViewerState();
      useViewerStore.getState().clearAllModels();
    });
    assert.equal(useViewerStore.getState().dimensions2D.length, 0, 'the reset cleared the live dimensions');
    useViewerStore.setState({ models: new Map([['model-a2', stubModel('model-a2', file)]]) });
    await act(async () => { useViewerStore.getState().setActiveModel('model-a2'); });
    await flush();

    assert.deepEqual(useViewerStore.getState().dimensions2D, [dimension], 'the reload restores the dimension from storage');
  });
});
