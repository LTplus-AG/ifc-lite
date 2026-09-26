/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5849: the real federated IFC loader publishes Cancel and keeps model #1. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useIfcLoader } from './useIfcLoader.js';

let loader: ReturnType<typeof useIfcLoader> | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Probe() {
  loader = useIfcLoader();
  return null;
}

beforeEach(async () => {
  const state = useViewerStore.getState();
  state.setActiveLoadCanceller(null);
  state.resetViewerState();
  state.clearAllModels();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  assert.ok(loader);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  host?.remove();
  host = null;
  loader = null;
});

it('federated IFC Cancel stops the pending load without clearing the existing scene or showing an error (#5849)', async () => {
  const previous = fixtureModel('existing-model', { idOffset: 0 });
  useViewerStore.setState({ ...fixtureModels(previous), selectedEntityId: 7 });
  const before = useViewerStore.getState();

  let resolveRead!: (buffer: ArrayBuffer) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const heldRead = new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve; });
  const file = new File(['ISO-10303-21;'], 'second.ifc');
  file.slice = () => {
    const head = new Blob([]);
    head.arrayBuffer = () => { readStarted(); return heldRead; };
    return head;
  };

  let pending!: Promise<void>;
  await act(async () => {
    pending = loader!.loadFile(file, { kind: 'federated', modelId: 'cancelled-add' });
    await started;
  });
  const during = useViewerStore.getState();
  assert.equal(during.loading, true);
  assert.equal(during.loadingFileName, 'second.ifc');
  assert.ok(during.activeLoadCanceller, 'the loading card must have a Cancel for a federated IFC add');

  await act(async () => {
    during.activeLoadCanceller?.();
    resolveRead(new ArrayBuffer(0));
    await pending;
  });

  const after = useViewerStore.getState();
  assert.equal(after.models, before.models, 'the previous model map is preserved');
  assert.equal(after.activeModelId, before.activeModelId);
  assert.equal(after.selectedEntityId, 7, 'existing selection survives Cancel');
  assert.equal(after.models.has('cancelled-add'), false);
  assert.equal(after.loading, false);
  assert.equal(after.error, null);
  assert.equal(after.activeLoadCanceller, null);
  assert.equal(after.loadingFileName, null);
});
