/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Round trip against the shared fixture provider, not a hand-written mock:
// download -> parse -> edit -> Save to source -> download again. #9522
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createFixtureContext, createFixtureSourceProvider } from '@ifc-lite/source-fixture';
import type { SourceFileRef, SourceTag } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { SourceHost } from './source-host';
import { bindSourceModel } from './model-writeback-binding';
import { saveSourceModel } from './model-writeback';

const step = (name: string) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0Proj00000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'${name}',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`;
const ref: SourceFileRef = { projectId: 'p', containerId: 'models', fileId: 'house' };
const parse = (bytes: ArrayBuffer) => new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });

function fixtureSource() {
  return createFixtureSourceProvider({
    world: { projects: [{ id: 'p', name: 'Project', containers: [{ id: 'models', name: 'Models' }, { id: 'out', name: 'Out' }],
      files: [{ id: 'house', name: 'House.ifc', containerId: 'models', revisions: [{ id: 'rev1', label: 'Revision 1', content: step('Before') }] }] }] },
    capabilities: { writeBack: ['new-version', 'new-file', 'new-location'] },
  });
}

/** Loads the fixture's current revision into the store the way a source open does. */
async function loadFromSource(provider: ReturnType<typeof fixtureSource>) {
  const ctx = createFixtureContext();
  const file = (await provider.listFiles(ctx, 'p', 'models')).items.find(item => item.id === 'house');
  assert.ok(file?.currentRevisionId);
  const store = await parse(await provider.download(ctx, ref));
  const view = new MutablePropertyView(store.properties, 'm'); configureMutationView(view, store);
  const tag: SourceTag = { provider: provider.manifest.name, ...ref, revisionId: file.currentRevisionId, loadedAt: 1 };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), name: 'House.ifc', ifcDataStore: store }),
    sourceTags: new Map([['m', tag]]), mutationViews: new Map([['m', view]]) });
  return { ctx, view };
}

afterEach(() => useViewerStore.setState({ models: new Map(), sourceTags: new Map(), mutationViews: new Map() }));

it('#9522 an edited model saved as a new version downloads back with the edit and advances the loaded revision', async () => {
  const provider = fixtureSource(), host = new SourceHost(); assert.equal(host.register(provider), true);
  const { ctx, view } = await loadFromSource(provider);
  view.setAttribute(10, 'Name', 'After', 'Before');
  const binding = bindSourceModel('m'); assert.ok(binding);

  const outcome = await saveSourceModel(host, binding, { mode: 'new-version', fileName: '', containerId: '' });
  assert.equal(outcome.kind, 'saved');
  assert.equal((await parse(await provider.download(ctx, ref))).entities.getName(10), 'After');
  assert.deepEqual((await provider.listRevisions!(ctx, ref)).items.map(r => r.id), ['rev2', 'rev1']);
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId, 'rev2');

  // The old binding is now stale; a fresh one saves on top of rev2 without a conflict.
  assert.deepEqual(await saveSourceModel(host, binding, { mode: 'new-version', fileName: '', containerId: '' }), { kind: 'model-changed' });
  view.setAttribute(10, 'Name', 'Again', 'After');
  const next = bindSourceModel('m'); assert.ok(next);
  assert.equal((await saveSourceModel(host, next, { mode: 'new-version', fileName: '', containerId: '' })).kind, 'saved');
  assert.equal((await parse(await provider.download(ctx, ref))).entities.getName(10), 'Again');
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId, 'rev3');
});

it('#9522 a revision uploaded elsewhere after load is a stale-base conflict and nothing is overwritten', async () => {
  const provider = fixtureSource(), host = new SourceHost(); assert.equal(host.register(provider), true);
  const { ctx, view } = await loadFromSource(provider);
  const binding = bindSourceModel('m'); assert.ok(binding);
  const external = await provider.uploadFile!(ctx, { mode: 'new-version', ref, baseRevisionId: 'rev1' }, new TextEncoder().encode(step('Theirs')).buffer);
  assert.equal(external.ok, true);

  view.setAttribute(10, 'Name', 'Mine', 'Before');
  const outcome = await saveSourceModel(host, binding, { mode: 'new-version', fileName: '', containerId: '' });
  assert.deepEqual(outcome, { kind: 'conflict', conflict: { kind: 'stale-base', currentRevisionId: 'rev2' } });
  assert.equal((await parse(await provider.download(ctx, ref))).entities.getName(10), 'Theirs');
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId, 'rev1');
});

it('#9522 new-location writes a new file into the chosen folder and relinks the model to it', async () => {
  const provider = fixtureSource(), host = new SourceHost(); assert.equal(host.register(provider), true);
  const { ctx, view } = await loadFromSource(provider);
  view.setAttribute(10, 'Name', 'Moved', 'Before');
  const binding = bindSourceModel('m'); assert.ok(binding);

  const outcome = await saveSourceModel(host, binding, { mode: 'new-location', fileName: 'House-edited.ifc', containerId: 'out' });
  assert.equal(outcome.kind, 'saved');
  const listed = (await provider.listFiles(ctx, 'p', 'out')).items;
  assert.deepEqual(listed.map(file => file.name), ['House-edited.ifc']);
  const tag = useViewerStore.getState().sourceTags.get('m');
  assert.equal(tag?.containerId, 'out'); assert.equal(tag?.fileId, listed[0].id);
  assert.equal((await parse(await provider.download(ctx, { projectId: 'p', containerId: 'out', fileId: listed[0].id }))).entities.getName(10), 'Moved');
  // The original file is untouched.
  assert.equal((await parse(await provider.download(ctx, ref))).entities.getName(10), 'Before');

  // A second save of the same name into the same folder is reported, never silently overwritten.
  const again = bindSourceModel('m'); assert.ok(again);
  const clash = await saveSourceModel(host, again, { mode: 'new-file', fileName: 'House-edited.ifc', containerId: '' });
  assert.equal(clash.kind, 'conflict');
  assert.equal((await provider.listFiles(ctx, 'p', 'out')).items.length, 1);
});
