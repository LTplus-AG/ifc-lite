/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared load UI (spinner, streaming flag, progress, Cancel) belongs to
 * every load still running, so only the last live owner ends it (L2). A
 * Cancel of a primary also ends the federated adds joining its scene (L5).
 * Real loader, real GLB parse; the held loads park on their head read.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { isGeometryLoadStreaming } from '@/lib/pick-gating';
import { cancelActivity, useActivityJournal } from '@/lib/activity/activity-journal';
import { buildTriangleGlb } from '@/test/triangle-glb.js';
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

/** A file whose head read parks until `release`, which then serves its real bytes. */
function heldFile(name: string, bytes: Uint8Array<ArrayBuffer>) {
  let readStarted!: () => void;
  let resolveHead!: (buffer: ArrayBuffer) => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const head = new Promise<ArrayBuffer>((resolve) => { resolveHead = resolve; });
  const file = new File([bytes], name);
  const slice = file.slice.bind(file);
  file.slice = (start?: number, end?: number) => {
    const part = slice(start, end);
    if (start !== 0 || end !== 4096) return part;
    part.arrayBuffer = () => { readStarted(); return head; };
    return part;
  };
  return { file, started, release: () => resolveHead(bytes.slice(0, 4096).buffer) };
}

const ifcBytes = () => new TextEncoder().encode('ISO-10303-21;');

function loadJob(subject: string): string {
  const job = useActivityJournal.getState().jobs.find((entry) => entry.subject === subject && entry.outcome === 'running');
  assert.ok(job, `${subject} has a running activity row`);
  return job.id;
}

const completingAdds = [
  { label: 'completes', file: () => new File([buildTriangleGlb(7)], 'quick.glb') },
  // Federated point cloud with no renderer: the load ends at once with an error.
  { label: 'fails', file: () => new File(['0 0 0\n1 1 1\n'], 'quick.xyz') },
] as const;

for (const add of completingAdds) {
  it(`a federated add that ${add.label} first leaves the load still running its spinner, progress and Cancel (L2)`, async () => {
    const held = heldFile('held.glb', buildTriangleGlb(9));
    let pending!: Promise<void>;
    await act(async () => {
      pending = loader!.loadFile(held.file, { kind: 'federated', modelId: 'held' });
      await held.started;
    });
    const heldCancel = useViewerStore.getState().activeLoadCanceller;
    assert.ok(heldCancel);
    useViewerStore.getState().setGeometryStreamingActive(true); // a stream still running beside the add

    await act(async () => { await loader!.loadFile(add.file(), { kind: 'federated', modelId: 'quick' }); });

    const during = useViewerStore.getState();
    assert.equal(during.loading, true, 'held.glb is still loading');
    assert.equal(during.geometryStreamingActive, true, 'the add never ends a stream it does not own');
    assert.equal(isGeometryLoadStreaming(during), true, 'picking stays gated while held.glb streams');
    assert.equal(during.activeLoadCanceller, heldCancel, 'held.glb keeps its Cancel');

    await act(async () => { held.release(); await pending; });
    const after = useViewerStore.getState();
    assert.ok(after.models.has('held'), 'held.glb completed');
    assert.equal(after.loading, false, 'the last load to end ends the spinner');
    assert.equal(after.geometryStreamingActive, false);
    assert.deepEqual(after.progress, { phase: 'Complete', percent: 100 });
    assert.equal(after.activeLoadCanceller, null);
    assert.equal(after.loadingFileName, null);
  });
}

it('a primary that completes while a federated add streams leaves the add its load UI (L2)', async () => {
  const primary = heldFile('primary.glb', buildTriangleGlb(3));
  const added = heldFile('added.ifc', ifcBytes());
  let primaryLoad!: Promise<void>;
  let addLoad!: Promise<void>;
  await act(async () => {
    primaryLoad = loader!.loadFile(primary.file, { kind: 'primary', modelId: 'primary' });
    await primary.started;
    addLoad = loader!.loadFile(added.file, { kind: 'federated', modelId: 'added' });
    await added.started;
  });
  const addCancel = useViewerStore.getState().activeLoadCanceller;
  assert.ok(addCancel);

  await act(async () => { primary.release(); await primaryLoad; });

  const during = useViewerStore.getState();
  assert.equal(during.models.get('primary')?.loadState, 'complete');
  assert.equal(during.loading, true, 'added.ifc is still loading');
  assert.equal(isGeometryLoadStreaming(during), true);
  assert.equal(during.activeLoadCanceller, addCancel);

  await act(async () => { addCancel(); added.release(); await addLoad; });
  assert.equal(useViewerStore.getState().loading, false);
});

it('a tray Cancel of a primary ends the federated add joining its scene and returns to an empty, idle viewer (L5)', async () => {
  const primary = heldFile('primary.glb', buildTriangleGlb(3));
  const added = heldFile('added.ifc', ifcBytes());
  let primaryLoad!: Promise<void>;
  let addLoad!: Promise<void>;
  await act(async () => {
    primaryLoad = loader!.loadFile(primary.file, { kind: 'primary', modelId: 'primary' });
    await primary.started;
    addLoad = loader!.loadFile(added.file, { kind: 'federated', modelId: 'added' });
    await added.started;
  });
  const primaryJob = loadJob('primary.glb');
  const addJob = loadJob('added.ifc');

  await act(async () => {
    cancelActivity(primaryJob);
    primary.release();
    added.release();
    await Promise.all([primaryLoad, addLoad]);
  });

  const after = useViewerStore.getState();
  assert.equal(after.loading, false, 'no spinner is left behind');
  assert.equal(after.progress, null);
  assert.equal(after.error, null, 'a user cancel is not an error');
  assert.deepEqual([...after.models.keys()], [], 'no half-loaded primary stays in the scene');
  assert.equal(after.activeLoadCanceller, null);
  const outcomes = useActivityJournal.getState().jobs
    .filter((job) => job.id === primaryJob || job.id === addJob)
    .map((job) => job.outcome);
  assert.deepEqual(outcomes, ['cancelled', 'cancelled'], 'both rows read as cancelled');
});
