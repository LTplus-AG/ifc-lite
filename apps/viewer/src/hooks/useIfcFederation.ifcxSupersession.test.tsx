/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * L7: a federated IFCX composition replaces the scene like a primary load, so
 * it takes part in the same load contract: it publishes a Cancel and an
 * activity row, a newer primary load supersedes it (its layers never land in
 * that load's scene), and Cancel returns to an empty, idle viewer.
 *
 * The composition is real (`parseFederatedIfcx` on a minimal IFCX). The
 * interleaving is fixed by starting the competing load, or pressing Cancel,
 * from a store subscription the moment the composition reports its parse
 * phase, i.e. while the parse is awaited.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { fixtureModel } from '@/test/store-fixture.js';
import { installModelLoadCanceller } from './modelLoadCanceller.js';
import { useIfcFederation } from './useIfcFederation.js';

/** Parses as IFCX with no entities; composition succeeds and lands one layer. */
function ifcxFile(name: string): File {
  const json = {
    header: { id: 'h', ifcxVersion: 'ifcx-alpha', dataVersion: '1', author: 't', timestamp: '' },
    imports: [],
    schemas: {},
    data: [],
  };
  return new File([new TextEncoder().encode(JSON.stringify(json))], name, { type: 'application/json' });
}

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
function Probe(): null {
  hookApi = useIfcFederation(async () => assert.fail('federated IFCX composes without loadFile'));
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  const state = useViewerStore.getState();
  state.setActiveLoadCanceller(null);
  state.resetViewerState();
  state.clearAllModels();
  state.clearLayerStack();
  useActivityJournal.setState({ jobs: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

const BEFORE_PARSE = (phase: string) => phase === 'Parsing federated IFCX';
const IN_PARSE = (phase: string) => phase.startsWith('IFCX ');

/** Runs `during` once, as soon as the composition reports a phase `at` matches. */
function whileParsing(during: () => void, at: (phase: string) => boolean = BEFORE_PARSE): void {
  let ran = false;
  const stop = useViewerStore.subscribe((state) => {
    if (ran || !state.progress || !at(state.progress.phase)) return;
    ran = true;
    during();
  });
  cleanups.push(stop);
}

function compositionRow() {
  return useActivityJournal.getState().jobs.find((job) => job.subject === 'base.ifcx');
}

it('a composition publishes a Cancel and an activity row, and settles both when it lands', async () => {
  let cancelWhileParsing: (() => void) | null = null;
  let rowWhileParsing: string | undefined;
  whileParsing(() => {
    cancelWhileParsing = useViewerStore.getState().activeLoadCanceller;
    rowWhileParsing = compositionRow()?.outcome;
  });

  await act(async () => hookApi!.loadFederatedIfcx([ifcxFile('base.ifcx')]));

  assert.ok(cancelWhileParsing, 'the loading card offers Cancel during the composition');
  assert.equal(rowWhileParsing, 'running');
  const after = useViewerStore.getState();
  assert.equal(after.models.size, 1, 'the composed layer landed');
  assert.equal(after.loading, false);
  assert.equal(after.activeLoadCanceller, null);
  assert.equal(compositionRow()?.outcome, 'completed');
});

for (const [when, at] of [['before', BEFORE_PARSE], ['during', IN_PARSE]] as const) it(`a primary load started ${when} the parse keeps its scene: no layers land in it (L7)`, async () => {
  let primaryCancel: (() => void) | null = null;
  whileParsing(() => {
    cleanups.push(installModelLoadCanceller('primary', () => {}));
    primaryCancel = useViewerStore.getState().activeLoadCanceller;
    useViewerStore.getState().addModel(fixtureModel('primary'));
    useViewerStore.getState().setProgress({ phase: 'Opening tower.ifc', percent: 5 });
  }, at);

  await act(async () => hookApi!.loadFederatedIfcx([ifcxFile('base.ifcx')]));

  const after = useViewerStore.getState();
  assert.deepEqual([...after.models.keys()], ['primary'], 'only the newer load\'s model is in the scene');
  assert.deepEqual([...after.layerStack], [], 'the superseded composition publishes no layer stack');
  assert.equal(after.loading, true, 'the newer load keeps its spinner');
  assert.equal(after.activeLoadCanceller, primaryCancel, 'and its Cancel');
  assert.deepEqual(after.progress, { phase: 'Opening tower.ifc', percent: 5 }, 'the superseded parse reports no more progress');
  assert.equal(compositionRow()?.outcome, 'cancelled');
});

it('Cancel during the composition returns to an empty, idle viewer (L7)', async () => {
  whileParsing(() => useViewerStore.getState().activeLoadCanceller?.());

  await act(async () => hookApi!.loadFederatedIfcx([ifcxFile('base.ifcx')]));

  const after = useViewerStore.getState();
  assert.deepEqual([...after.models.keys()], []);
  assert.deepEqual([...after.layerStack], []);
  assert.equal(after.loading, false);
  assert.equal(after.error, null, 'a user cancel is not an error');
  assert.equal(after.activeLoadCanceller, null);
  assert.equal(compositionRow()?.outcome, 'cancelled');
});

it('a composition cancelled before its parse fails reports no error over the viewer (L7)', async () => {
  whileParsing(() => useViewerStore.getState().activeLoadCanceller?.());
  // Detected as IFCX by its leading `{`, but not JSON: the parse rejects.
  const bad = new File(['{ not json'], 'base.ifcx', { type: 'application/json' });

  await act(async () => hookApi!.loadFederatedIfcx([bad]));

  assert.equal(useViewerStore.getState().error, null, 'a cancelled composition owns no error');
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
  assert.equal(compositionRow()?.outcome, 'cancelled');
});

it('a composition that fails on its own reports the error and ends its load UI', async () => {
  const bad = new File(['{ not json'], 'base.ifcx', { type: 'application/json' });

  await act(async () => hookApi!.loadFederatedIfcx([bad]));

  const after = useViewerStore.getState();
  assert.match(after.error ?? '', /Federated IFCX loading failed/);
  assert.ok(after.lastLoadRetry, 'with a Retry');
  assert.equal(after.loading, false, 'no spinner is left behind');
  assert.equal(after.activeLoadCanceller, null, 'and no Cancel');
  assert.equal(after.loadingFileName, null);
  assert.equal(compositionRow()?.outcome, 'failed');
});
