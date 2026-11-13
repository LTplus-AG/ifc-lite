/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `.3dm` load through the canonical `useIfcLoader.loadFile` path, with the
 * real reader behind an in-process worker: content detection, the adapter, and
 * `finalizeModel` for a primary model and then a federated one.
 *
 * It pins the branch reaching `finalizeModel` at all. The first version
 * `return`ed the load promise, and `loadFile`'s `finally` aborts
 * `metadataAbort` as soon as the `return` statement runs, so the read was
 * cancelled mid-flight and the model sat at `streaming-geometry` for ever with
 * no error. The viewport showed nothing and nothing in the unit tests noticed.
 *
 * Spec: docs/architecture/rhino-3dm-import.md.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readRhino3dm } from '@ifc-lite/rhino3dm';
import { useViewerStore } from '@/store';
import { isSupportedModelFile } from '@/services/supported-model-files';
import { installFakeRhinoImportWorker, type FakeRhinoImportWorkerHandle } from '@/test/rhino-import-worker-fake.js';
import { CRAFTED_GLOBAL_ID, CRAFTED_VERTEX_VIEWER, craftRhino3dm } from '@/test/rhino-3dm-fixture.js';
import { useIfcLoader } from './useIfcLoader.js';

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let fake: FakeRhinoImportWorkerHandle | null = null;
let bytes: Uint8Array | null = null;

const file = (name: string) => new File([bytes!.slice()], name, { type: 'application/octet-stream' });

beforeEach(async () => {
  bytes ??= await craftRhino3dm();
  // The real reader, in process: only the worker hop is faked.
  fake = installFakeRhinoImportWorker({ read: (input, options) => readRhino3dm(input, options) });
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  fake?.restore();
  fake = null;
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('useIfcLoader .3dm route', () => {
  it('opens a .3dm as a primary model, settled, with its entities and meshes', async () => {
    assert.equal(isSupportedModelFile(file('crafted.3dm')), true, 'the drop guard admits it');

    await act(async () => hookApi!.loadFile(file('crafted.3dm'), { kind: 'primary' }));

    const model = [...useViewerStore.getState().models.values()][0];
    assert.ok(model, 'the model was registered');
    assert.equal(model.loadState, 'complete', 'the load settled rather than hanging mid-read');
    assert.equal(model.loadPath, '3dm');
    assert.equal(model.schemaVersion, 'IFC4');
    assert.equal(model.ifcDataStore?.sourceKind, 'tabular');
    assert.equal(model.loadError, null);
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(model.ifcDataStore?.entityCount, 2);
    assert.equal(model.ifcDataStore?.entities.getGlobalId(1), CRAFTED_GLOBAL_ID);
    assert.equal(model.geometryResult?.meshes.length, 2);
    assert.equal(model.geometryResult?.totalTriangles, 2);
    assert.deepEqual([...(model.geometryResult?.meshes[0].origin ?? [])], [...CRAFTED_VERTEX_VIEWER]);
    assert.equal(fake!.spawned(), 1, 'one worker per load');
    assert.equal(fake!.terminated(), 1, 'and it is terminated when the read settles');
  });

  it('adds a second .3dm as a federated model on its own express id range', async () => {
    await act(async () => hookApi!.loadFile(file('first.3dm'), { kind: 'primary' }));
    const first = [...useViewerStore.getState().models.values()][0];

    await act(async () => hookApi!.loadFile(file('second.3dm'), { kind: 'federated', modelId: 'rhino-federated' }));

    const second = useViewerStore.getState().models.get('rhino-federated');
    assert.ok(second?.geometryResult);
    assert.equal(second.loadPath, '3dm');
    assert.ok(second.idOffset > first.maxExpressId, 'the federated range starts past the primary watermark');
    assert.equal(second.geometryResult.meshes[0].expressId, 1 + second.idOffset);
    assert.equal(useViewerStore.getState().models.size, 2);
  });

  it('shows the reader refusal for a file that is not a .3dm after all', async () => {
    const damaged = new Uint8Array(bytes!.slice(0, 2048));
    damaged.set([0, 0, 0, 0], 1024);

    await act(async () => hookApi!.loadFile(new File([damaged], 'damaged.3dm'), { kind: 'primary' }));

    const model = [...useViewerStore.getState().models.values()][0];
    assert.equal(model.loadState, 'error');
    // The hierarchy panel renders `loadError` verbatim, so it holds the
    // reader's sentence, not its code.
    assert.match(model.loadError ?? '', /Not a Rhino \.3dm file/);
    assert.match(useViewerStore.getState().error ?? '', /Rhino \.3dm file/);
    assert.equal(fake!.terminated(), 1, 'a refusal terminates the worker too');
  });
});
