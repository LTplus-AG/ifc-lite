/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { PLUGIN_API_VERSION, type FileSourceProvider, type SourceFile } from '@ifc-lite/plugin-api';
import { cleanup, click, render, waitFor } from '@/test/render';
import { SourceHost, SOURCE_DOWNLOAD_EVENT, type SourceDownloadEvent, type SourceDownloadItem } from '@/services/sources/source-host';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { ActivityTrayList } from '@/components/viewer/activity/ActivityTrayList';
import { useSourceDownloadBatch } from './useSourceDownloadBatch';
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useActivityJournal.setState({ jobs: [] }); });
const files: SourceFile[] = [1, 2].map(id => ({ id: String(id), name: `Authored ${id}.ifc`, containerId: 'models', currentRevisionId: 'revision' }));
async function setup() {
  useActivityJournal.setState({ jobs: [] });
  const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const authored = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve(response: Response): void }> = [];
  globalThis.fetch = ((_input, init) => new Promise<Response>(resolve => { pending.push({ signal: init?.signal, resolve }); })) as typeof fetch;
  const provider: FileSourceProvider = {
    manifest: { name: 'authored-fixture-files', title: 'Authored IFC source', api: PLUGIN_API_VERSION,
      auth: 'preferences', permissions: { network: ['fixtures.example'] }, preferences: [], contributes: { fileSources: [] },
      capabilities: { containerListing: 'direct-children', listFilesIsRecursive: false, revisionHistory: false,
        downloadHistoricalRevisions: false, changeDetection: false, search: false } },
    listProjects: async () => ({ items: [] }), listContainers: async () => ({ items: [] }), listFiles: async () => ({ items: files }),
    async download(ctx, ref, options) {
      const response = await ctx.fetch(`https://fixtures.example/${ref.fileId}`, { signal: options?.signal });
      if (!response.ok) throw new Error(`Download refused: ${response.status}`);
      const buffer = await response.arrayBuffer();
      options?.onProgress?.(buffer.byteLength, buffer.byteLength);
      return buffer;
    },
  };
  const host = new SourceHost();
  const dispatched: SourceDownloadItem[] = [];
  const onDispatch = (event: Event) => dispatched.push(...(event as SourceDownloadEvent).detail.items);
  window.addEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch);
  let succeeded = 0;
  function Harness() {
    const batch = useSourceDownloadBatch({ provider, providerId: provider.manifest.name, sourceHost: host,
      onBatchSucceeded: () => { succeeded++; } });
    return <><button onClick={() => { void batch.handleDownload({ projectId: 'project', files }); }}>Load authored files</button>
      <button onClick={batch.cancelDownload}>Native Cancel</button><output>{batch.downloading ? 'Downloading' : 'Idle'}</output><ActivityTrayList /></>;
  }
  const ui = render(<Harness />);
  const start = () => {
    click(ui.querySelector<HTMLButtonElement>('button')!);
    assert.ok(useActivityJournal.getState().jobs.at(-1), 'native source download enters Activity before network completion');
  };
  const settle = async (index: number, status = 200) => {
    await act(async () => pending[index].resolve(new Response(status === 200 ? new Uint8Array(bytes) : 'Refused', { status })));
  };
  const assertAuthoredDispatch = async () => {
    for (const item of dispatched) {
      const parsed = await new IfcParser().parseColumnar(item.buffer, { disableWorkerScan: true });
      const wall = authored.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall);
      assert.equal(parsed.entityIndex.byType.get('IFCWALL')?.length, authored.entityIndex.byType.get('IFCWALL')?.length);
      assert.equal(parsed.entities.getGlobalId(wall), authored.entities.getGlobalId(wall));
      assert.equal(item.tag.provider, provider.manifest.name);
    }
  };
  return { ui, start, pending, settle, dispatched, assertAuthoredDispatch, succeeded: () => succeeded,
    removeListener: () => window.removeEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch) };
}
it('#7134 native source tray Cancel rejects late authored bytes and retained callback cannot cancel retry', async () => {
  const run = await setup();
  try {
    run.start(); await waitFor(() => run.pending.length === 1, 'first native request');
    const row = useActivityJournal.getState().jobs.at(-1); assert.ok(row);
    const oldCancel = activityCanceller(row.id); assert.ok(oldCancel);
    const cancel = run.ui.querySelector<HTMLButtonElement>('button[aria-label="Cancel Download source files"]'); assert.ok(cancel); click(cancel);
    assert.equal(run.pending[0].signal?.aborted, true);
    await run.settle(0); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'cancelled', 'cancelled native batch');
    assert.equal(run.dispatched.length, 0); assert.equal(activityCanceller(row.id), null);
    run.start(); await waitFor(() => run.pending.length === 2, 'retry native request');
    act(() => oldCancel()); assert.equal(run.pending[1].signal?.aborted, false);
    await run.settle(1); await waitFor(() => run.pending.length === 3, 'second retry file');
    assert.deepEqual(useActivityJournal.getState().jobs.at(-1)?.progress, { done: 1, total: 2 });
    await run.settle(2); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'complete native dispatch');
    assert.equal(run.dispatched.length, 2); assert.equal(run.succeeded(), 1); await run.assertAuthoredDispatch();
    assert.equal(activityCanceller(useActivityJournal.getState().jobs.at(-1)!.id), null);
  } finally { run.removeListener(); }
});
it('#7134 native panel Cancel after dispatch reports Partial without removing already dispatched authored IFC', async () => {
  const run = await setup();
  try {
    run.start(); await waitFor(() => run.pending.length === 1, 'first file'); await run.settle(0);
    await waitFor(() => run.pending.length === 2, 'second file');
    click([...run.ui.querySelectorAll('button')].find(button => button.textContent === 'Native Cancel')!);
    await run.settle(1); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'partial', 'partial cancelled batch');
    const row = useActivityJournal.getState().jobs.at(-1)!;
    assert.match(row.detail ?? '', /Cancelled after dispatching 1 file.*remain available/);
    assert.equal(run.dispatched.length, 1); assert.equal(run.succeeded(), 0); await run.assertAuthoredDispatch();
    assert.equal(activityCanceller(row.id), null);
  } finally { run.removeListener(); }
});
for (const successfulSecond of [false, true]) it(`#7134 native source failure records ${successfulSecond ? 'Partial after actual dispatch' : 'Failed with no dispatch'}`, async () => {
  const run = await setup();
  try {
    run.start(); await waitFor(() => run.pending.length === 1, 'first file'); await run.settle(0, 403);
    await waitFor(() => run.pending.length === 2, 'second file'); await run.settle(1, successfulSecond ? 200 : 403);
    await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome !== 'running', 'native batch settled');
    const row = useActivityJournal.getState().jobs.at(-1)!;
    assert.equal(row.outcome, successfulSecond ? 'partial' : 'failed');
    assert.match(row.detail ?? '', successfulSecond ? /some downloads failed.*remain available/ : /2 downloads failed.*no files were dispatched/);
    assert.equal(run.dispatched.length, successfulSecond ? 1 : 0); assert.equal(run.succeeded(), 0);
    await run.assertAuthoredDispatch(); assert.equal(activityCanceller(row.id), null);
  } finally { run.removeListener(); }
});
it('#7134 superseded native batch row cannot abort newer download and late old bytes are not dispatched', async () => {
  const run = await setup();
  try {
    run.start(); await waitFor(() => run.pending.length === 1, 'old batch');
    const old = useActivityJournal.getState().jobs.at(-1)!; const cancel = activityCanceller(old.id); assert.ok(cancel);
    run.start(); await waitFor(() => run.pending.length === 2, 'new batch');
    act(() => cancel()); assert.equal(run.pending[0].signal?.aborted, true); assert.equal(run.pending[1].signal?.aborted, false);
    await run.settle(0); assert.equal(useActivityJournal.getState().jobs.find(row => row.id === old.id)?.outcome, 'cancelled');
    assert.equal(run.dispatched.length, 0); assert.ok(run.ui.textContent?.includes('Downloading'));
    await run.settle(1); await waitFor(() => run.pending.length === 3, 'new second file'); await run.settle(2);
    await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'new batch completed');
    assert.equal(run.dispatched.length, 2); await run.assertAuthoredDispatch();
  } finally { run.removeListener(); }
});
it('#7134 native source unmount preserves abort ownership and cleans terminal Activity callback', async () => {
  const run = await setup();
  try {
    run.start(); await waitFor(() => run.pending.length === 1, 'native request'); const row = useActivityJournal.getState().jobs.at(-1); assert.ok(row);
    cleanup(); assert.equal(run.pending[0].signal?.aborted, true); await run.settle(0);
    await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'cancelled', 'unmounted run settled');
    assert.equal(run.dispatched.length, 0); assert.equal(activityCanceller(row.id), null);
  } finally { run.removeListener(); }
});
