/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { cleanup, click, render, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { ActivityTrayList } from '@/components/viewer/activity/ActivityTrayList';
import { useExportCommands, type CsvExportType } from './useExportCommands';

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
afterEach(() => {
  cleanup(); mock.restoreAll(); URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
  useActivityJournal.setState({ jobs: [] });
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, mutationViews: new Map() });
});
const modes: CsvExportType[] = ['entities', 'properties', 'quantities', 'spatial'];
async function setup(federated = false) {
  const bytes = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const wall = store.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall, 'authored SketchUp wall');
  const view = new MutablePropertyView(store.properties ?? null, 'authored');
  configureMutationView(view, store);
  view.setAttribute(wall, 'Name', 'Reviewed CSV wall', store.entities.getName(wall) ?? '');
  const model = { ...fixtureModel('authored'), name: 'Authored.ifc', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(model, ...(federated ? [fixtureModel('peer')] : [])),
    ifcDataStore: store, mutationViews: new Map([['authored', view]]) });
  useActivityJournal.setState({ jobs: [] });
  const blobs: Blob[] = [];
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob); return `blob:csv-${blobs.length}`; };
  URL.revokeObjectURL = () => {};
  let running: Promise<void> | undefined;
  function Harness() {
    const commands = useExportCommands('ribbon');
    return <>{modes.map(mode => <button key={mode} onClick={() => { running = commands.handleExportCSV(mode); }}>{mode}</button>)}<ActivityTrayList /></>;
  }
  const ui = render(<Harness />);
  const start = (mode: CsvExportType) => {
    const button = [...ui.querySelectorAll('button')].find(candidate => candidate.textContent === mode); assert.ok(button);
    click(button); assert.ok(running); return running;
  };
  return { ui, blobs, start, wall, store, guid: store.entities.getGlobalId(wall) };
}
function latest() {
  const job = useActivityJournal.getState().jobs.at(-1); assert.ok(job, '#7162 native CSV invocation enters Activity'); return job;
}
for (const mode of modes) it(`#7162 actual Rust ${mode} CSV publishes before Completed and exports native edited IFC`, async t => {
  if (!ensureWasm(t)) return;
  const run = await setup(true);
  const pending = run.start(mode);
  const job = latest();
  assert.equal(job.outcome, 'running'); assert.equal(activityCanceller(job.id), null);
  assert.match(job.subject ?? '', /Authored.ifc.*active model only.*1 other loaded model/);
  assert.equal(run.ui.querySelector('button[aria-label^="Cancel Export model"]'), null);
  await act(async () => { await pending; });
  assert.equal(latest().id, job.id); assert.equal(latest().outcome, 'completed');
  assert.equal(run.blobs.length, 1); assert.equal(run.blobs[0].type, 'text/csv');
  const csv = await run.blobs[0].text();
  assert.ok(csv.trim().split('\n').length > 1, 'real authored IFC emits table rows');
  if (mode === 'entities' || mode === 'spatial') {
    assert.ok(csv.includes('Reviewed CSV wall'), 'native mutation reached the actual Rust table');
    assert.ok(csv.includes(run.guid ?? 'missing-guid'), 'authored GlobalId retained');
  } else {
    assert.match(csv, /IfcWall/, 'actual authored wall metadata, not a fabricated export');
    assert.match(csv, mode === 'properties' ? /psetName,propName,value/ : /qsetName,quantityName,value/);
  }
});
it('#7162 native browser publication failure is Failed after actual Rust CSV production', async t => {
  if (!ensureWasm(t)) return;
  const run = await setup();
  URL.createObjectURL = () => { throw new Error('Browser refused CSV publication'); };
  await act(async () => { await run.start('entities'); });
  assert.equal(latest().outcome, 'failed'); assert.match(latest().detail ?? '', /Browser refused CSV publication/);
  assert.equal(activityCanceller(latest().id), null); assert.equal(run.blobs.length, 0);
});
it('#7162 overlapping native CSV writes keep independent background rows without invented Cancel', async t => {
  if (!ensureWasm(t)) return;
  const run = await setup();
  const releases: Array<() => void> = [];
  const nativeInit = GeometryProcessor.prototype.init;
  mock.method(GeometryProcessor.prototype, 'init', async function(this: GeometryProcessor) {
    await nativeInit.call(this);
    await new Promise<void>(resolve => { releases.push(resolve); });
  });
  const pending: Promise<void>[] = [];
  try {
    const first = run.start('entities'); pending.push(first);
    await waitFor(() => releases.length === 1, 'first initialized actual Rust processor');
    const firstJob = latest();
    const second = run.start('quantities'); pending.push(second);
    await waitFor(() => releases.length === 2, 'two initialized actual Rust processors');
    const secondJob = latest();
    assert.notEqual(firstJob.id, secondJob.id);
    cleanup();
    await act(async () => { releases[0](); await first; });
    assert.equal(useActivityJournal.getState().jobs.find(job => job.id === firstJob.id)?.outcome, 'completed');
    assert.equal(useActivityJournal.getState().jobs.find(job => job.id === secondJob.id)?.outcome, 'running');
    assert.equal(activityCanceller(secondJob.id), null);
    await act(async () => { releases[1](); await second; });
    assert.equal(useActivityJournal.getState().jobs.find(job => job.id === secondJob.id)?.outcome, 'completed');
    assert.equal(run.blobs.length, 2);
    assert.ok((await run.blobs[0].text()).includes('Reviewed CSV wall'));
    assert.match(await run.blobs[1].text(), /qsetName,quantityName,value/);
  } finally {
    releases.forEach(release => release()); await Promise.all(pending);
  }
});
it('#7162 native no-model preflight creates no export job or file', async () => {
  const run = await setup();
  await act(async () => { useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null }); });
  await act(async () => { await run.start('entities'); });
  assert.equal(useActivityJournal.getState().jobs.length, 0); assert.equal(run.blobs.length, 0);
});

it('#7162 real CSV keeps invocation source identity when active model switches during native initialization', async t => {
  if (!ensureWasm(t)) return;
  const run = await setup();
  let release: (() => void) | undefined;
  const nativeInit = GeometryProcessor.prototype.init;
  mock.method(GeometryProcessor.prototype, 'init', async function(this: GeometryProcessor) {
    await nativeInit.call(this);
    await new Promise<void>(resolve => { release = resolve; });
  });
  const names: string[] = [];
  mock.method(HTMLAnchorElement.prototype, 'click', function(this: HTMLAnchorElement) { names.push(this.download); });
  const pending = run.start('entities');
  try {
    await waitFor(() => Boolean(release), 'actual source A processor initialized');
    const job = latest(); assert.equal(job.subject, 'Authored.ifc');
    const other = { ...fixtureModel('other'), name: 'Other.ifc', ifcDataStore: run.store };
    await act(async () => { useViewerStore.setState({ ...fixtureModels(other), ifcDataStore: run.store, mutationViews: new Map() }); });
    assert.equal(useViewerStore.getState().activeModelId, 'other');
    await act(async () => { release?.(); await pending; });
    assert.equal(latest().id, job.id); assert.equal(latest().subject, 'Authored.ifc');
    assert.equal(latest().outcome, 'completed');
    assert.equal(run.blobs.length, 1);
    assert.ok((await run.blobs[0].text()).includes('Reviewed CSV wall'), 'actual exported A edit survived switching to unedited B');
    assert.deepEqual(names, ['Authored_entities.csv'], 'browser filename identifies the same source as bytes and Activity row');
  } finally { release?.(); await pending; }
});
