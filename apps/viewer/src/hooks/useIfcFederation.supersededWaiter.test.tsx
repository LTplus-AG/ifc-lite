/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * L6: a federated add queued behind the memory gate belongs to the scene it
 * was asked for. A primary load that starts while it waits replaces that
 * scene, so the add leaves the queue: it never wakes into the new primary's
 * scene, loads nothing there and leaves the primary's error alone. A newer
 * federated add does not supersede it.
 *
 * `loadFile` is stubbed with deferred promises; the starting primary is the
 * real `installModelLoadCanceller`, the call every primary load makes.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { __resetFederationLoadGate } from './federationLoadGate.js';
import { installModelLoadCanceller } from './modelLoadCanceller.js';
import { useIfcFederation } from './useIfcFederation.js';
import type { LoadTarget } from './useIfcLoader.js';
import type { ModelLoadOptions } from './modelLoadOptions.js';

let started: Array<{ modelId: string; register(): void }> = [];

const loadFileStub = (_file: File, target?: LoadTarget, options?: ModelLoadOptions): Promise<void> =>
  new Promise<void>((resolve) => {
    const modelId = target?.kind === 'federated' ? target.modelId : assert.fail('addModel loads a federated target');
    started.push({
      modelId,
      register: () => {
        useViewerStore.getState().addModel(fixtureModel(modelId, { idOffset: started.length * 1_000_000 }));
        options?.onModelRegistered?.();
        resolve();
      },
    });
  });

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
function Probe(): null {
  hookApi = useIfcFederation(loadFileStub);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const releases: Array<() => void> = [];

beforeEach(async () => {
  started = [];
  __resetFederationLoadGate();
  useViewerStore.getState().setActiveLoadCanceller(null);
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

/** 1000 MB: one fits the default budget, a second queues behind it. */
function large(name: string): File {
  const file = new File(['ISO-10303-21;'], name);
  Object.defineProperty(file, 'size', { value: 1000 * 1024 * 1024 });
  return file;
}

async function loadsStarted(count: number): Promise<void> {
  for (let i = 0; i < 50 && started.length < count; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(started.length, count, `${count} loads reached loadFile`);
}

it('a queued add superseded by a primary leaves the queue and never touches the primary (L6)', async () => {
  const first = hookApi!.addModel(large('first.ifc'), { modelId: 'first' });
  await loadsStarted(1);
  const queued = hookApi!.addModel(large('queued.ifc'), { modelId: 'queued' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(started.length, 1, 'the second add waits at the gate');

  // A primary load starts and fails while the add waits.
  releases.push(installModelLoadCanceller('primary', () => {}));
  useViewerStore.getState().setError('primary.ifc failed to parse');

  started[0].register();
  await first;
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(started.length, 1, 'the superseded add never loaded');
  assert.equal(await queued, null, 'the superseded add reports no model');
  assert.equal(useViewerStore.getState().models.has('queued'), false);
  assert.equal(useViewerStore.getState().error, 'primary.ifc failed to parse', 'the primary keeps its error');
});

it('a newer federated add does not supersede a queued one', async () => {
  const first = hookApi!.addModel(large('first.ifc'), { modelId: 'first' });
  await loadsStarted(1);
  const queued = hookApi!.addModel(large('queued.ifc'), { modelId: 'queued' });
  releases.push(installModelLoadCanceller('federated', () => {}));

  started[0].register();
  await first;
  await loadsStarted(2);
  started[1].register();
  assert.equal(await queued, 'queued');
});
