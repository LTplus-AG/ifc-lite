/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, advance } from '@/test/render';
import { EXPORTER, NativeExporterHost, nativeExporterHost, installNativeExporter, mountExporters } from '@/test/extension-export-fixture';
import { useViewerStore } from '@/store';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';

const initial = useViewerStore.getState();
const originalObjectURL = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalClick = HTMLAnchorElement.prototype.click;
const hosts: NativeExporterHost[] = [];
function capturePublication() {
  const blobs: Blob[] = [], filenames: string[] = [];
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob); return 'blob:native-export'; };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function () { filenames.push(this.download); };
  return { blobs, filenames };
}
async function waitForOutput(host: NativeExporterHost, owner: string) {
  for (let attempt = 0; attempt < 200 && !host.delivered.has(owner); attempt++) await advance(10);
  assert.ok(host.delivered.has(owner), 'the actual installed handler has produced its output');
}
afterEach(async () => {
  cleanup();
  for (const host of hosts.splice(0)) await host.dispose();
  useViewerStore.setState(initial, true);
  useActivityJournal.setState({ jobs: [] });
  URL.createObjectURL = originalObjectURL;
  URL.revokeObjectURL = originalRevoke;
  HTMLAnchorElement.prototype.click = originalClick;
});
test('#7170 actual installed QuickJS export publishes authored wall identities before Activity completes', async () => {
  useActivityJournal.setState({ jobs: [] });
  const host = await nativeExporterHost(); hosts.push(host);
  const owner = 'com.campaign.native-export-success';
  await installNativeExporter(host, owner);
  const { blobs, filenames } = capturePublication();
  const controls = mountExporters(host);
  await act(async () => { await controls.current.runExtensionExporter(`${owner}:${EXPORTER}`); });
  assert.equal(blobs.length, 1, 'the actual native handler publishes a browser blob');
  const output = JSON.parse(await blobs[0].text()) as { owner: string; walls: Array<{ GlobalId: string; Name: string }> };
  assert.equal(output.owner, owner);
  assert.equal(output.walls.length, 4, 'native IFC query returns the authored SketchUp walls');
  assert.equal(new Set(output.walls.map(wall => wall.GlobalId)).size, 4);
  assert.ok(output.walls.every(wall => wall.Name && wall.GlobalId.length === 22));
  assert.match(filenames[0], /building-architecture\.json$/);
  const jobs = useActivityJournal.getState().jobs;
  assert.equal(jobs.length, 1, 'the actual native exporter and publication belong to one Activity row');
  assert.equal(jobs[0].outcome, 'completed');
  assert.ok(jobs[0].subject?.includes(owner), 'the row identifies the actual extension owner');
});

test('#7170 native extension export stays running without invented Cancel and completes after surface closure', async () => {
  useActivityJournal.setState({ jobs: [] });
  const host = await nativeExporterHost(); hosts.push(host);
  const owner = 'com.campaign.native-export-background';
  await installNativeExporter(host, owner);
  let release: () => void = () => undefined;
  host.gates.set(owner, new Promise<void>(resolve => { release = resolve; }));
  const publication = capturePublication();
  const controls = mountExporters(host);
  let pending: Promise<void> | undefined;
  act(() => { pending = controls.current.runExtensionExporter(`${owner}:${EXPORTER}`); });
  try {
    await waitForOutput(host, owner);
    const [job] = useActivityJournal.getState().jobs; assert.ok(job);
    assert.equal(job.outcome, 'running');
    assert.equal(activityCanceller(job.id), null);
    assert.equal(publication.blobs.length, 0, 'delivering native output is still before browser publication');
    cleanup();
    assert.equal(useActivityJournal.getState().jobs[0].outcome, 'running');
  } finally { await act(async () => { release(); await pending; }); }
  assert.equal(publication.blobs.length, 1);
  assert.equal(useActivityJournal.getState().jobs[0].outcome, 'completed');
});

for (const failure of ['handler', 'publication'] as const) test(`#7170 actual ${failure} refusal fails its owned extension row`, async () => {
  useActivityJournal.setState({ jobs: [] });
  const host = await nativeExporterHost(); hosts.push(host);
  const owner = `com.campaign.native-export-${failure}`;
  await installNativeExporter(host, owner, failure === 'handler');
  const publication = capturePublication();
  if (failure === 'publication') HTMLAnchorElement.prototype.click = () => { throw new Error('native browser publication refused'); };
  const controls = mountExporters(host);
  await act(async () => { await controls.current.runExtensionExporter(`${owner}:${EXPORTER}`); });
  const [job] = useActivityJournal.getState().jobs; assert.ok(job);
  assert.equal(job.outcome, 'failed');
  assert.match(job.detail ?? '', /native (extension handler|browser publication) refused/);
  assert.equal(publication.filenames.length, 0);
  assert.equal(publication.blobs.length, failure === 'handler' ? 0 : 1);
});

test('#7170 duplicate exporter IDs in two owners retain independent native output and Activity rows', async () => {
  useActivityJournal.setState({ jobs: [] });
  const host = await nativeExporterHost(); hosts.push(host);
  const owners = ['com.campaign.native-export-a', 'com.campaign.native-export-b'];
  const releases: Array<() => void> = [];
  for (const owner of owners) {
    await installNativeExporter(host, owner);
    host.gates.set(owner, new Promise<void>(resolve => { releases.push(resolve); }));
  }
  const publication = capturePublication();
  const controls = mountExporters(host);
  let pending: Promise<void>[] = [];
  act(() => { pending = owners.map(owner => controls.current.runExtensionExporter(`${owner}:${EXPORTER}`)); });
  try {
    for (const owner of owners) await waitForOutput(host, owner);
    assert.equal(useActivityJournal.getState().jobs.filter(job => job.outcome === 'running').length, 2);
    await act(async () => { releases[0](); await pending[0]; });
    const jobs = useActivityJournal.getState().jobs;
    assert.equal(jobs.find(job => job.subject?.includes(owners[0]))?.outcome, 'completed');
    assert.equal(jobs.find(job => job.subject?.includes(owners[1]))?.outcome, 'running');
  } finally { await act(async () => { for (const release of releases) release(); await Promise.all(pending); }); }
  assert.equal(useActivityJournal.getState().jobs.filter(job => job.outcome === 'completed').length, 2);
  assert.deepEqual(await Promise.all(publication.blobs.map(async blob => JSON.parse(await blob.text()).owner)), owners);
});

test('#7170 absent host and unregistered owner are refused before any Activity or browser publication', async () => {
  useActivityJournal.setState({ jobs: [] });
  const publication = capturePublication();
  const absent = mountExporters(null);
  assert.deepEqual(absent.current.exporters, []);
  await assert.rejects(absent.current.runExtensionExporter('missing:native-walls'), /Unregistered extension exporter/);
  cleanup();
  const host = await nativeExporterHost(); hosts.push(host);
  await installNativeExporter(host, 'com.campaign.native-export-registered');
  const present = mountExporters(host);
  await assert.rejects(present.current.runExtensionExporter('other:native-walls'), /Unregistered extension exporter/);
  assert.equal(useActivityJournal.getState().jobs.length, 0);
  assert.equal(publication.blobs.length, 0);
});
