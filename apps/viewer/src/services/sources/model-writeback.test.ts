/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PLUGIN_API_VERSION, type FileSourceProvider, type SourceTag, type UploadTarget, type UploadResult } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { saveSourceCatalogCache, loadSourceCatalogCache, readSourceCatalogCacheOwner, syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { configureMutationView } from '@/utils/configureMutationView';
import { SourceHost } from './source-host';
import { bindSourceModel } from './model-writeback-binding';
import { saveSourceModel } from './model-writeback';

const text = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0Proj00000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Before',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`;
const tag: SourceTag = { provider: 'writeback-test', projectId: 'project', containerId: 'folder', fileId: 'file', revisionId: 'v1', loadedAt: 1 };
const destination = { mode: 'new-version', fileName: 'unused.ifc', containerId: 'unused' } as const;
const parse = (bytes: ArrayBuffer) => new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
const success: UploadResult = { ok: true, file: { id: 'file', containerId: 'folder', name: 'House.ifc', currentRevisionId: 'v2' }, revision: { id: 'v2', label: '2', createdAt: '2026-11-15' } };
async function setup(upload: NonNullable<FileSourceProvider['uploadFile']>) {
  const store = await parse(new TextEncoder().encode(text).buffer);
  const model = { ...fixtureModel('m'), name: 'House.ifc', ifcDataStore: store };
  const view = new MutablePropertyView(store.properties, 'm'); configureMutationView(view, store);
  useViewerStore.setState({ ...fixtureModels(model), sourceTags: new Map([['m', { ...tag }]]), mutationViews: new Map([['m', view]]) });
  const provider: FileSourceProvider = {
    manifest: { name: tag.provider, title: 'Test source', api: PLUGIN_API_VERSION, auth: 'preferences', preferences: [],
      permissions: { network: ['source.example'] }, contributes: { fileSources: ['./provider.ts'] },
      capabilities: { containerListing: 'direct-children', listFilesIsRecursive: false, revisionHistory: false,
        downloadHistoricalRevisions: false, changeDetection: false, search: false, writeBack: ['new-version','new-file','new-location'] } },
    listProjects: async () => ({ items: [] }), listContainers: async () => ({ items: [] }), listFiles: async () => ({ items: [] }),
    download: async () => { throw Error('No download in write-back test'); }, uploadFile: upload,
  };
  const host = new SourceHost(); assert.equal(host.register(provider), true);
  const binding = bindSourceModel('m'); assert.ok(binding);
  return { store, view, host, binding, provider };
}
afterEach(() => useViewerStore.setState({ models: new Map(), sourceTags: new Map(), mutationViews: new Map() }));

it('#9522 sends the actual edited model and loaded base revision; same-named models cannot redirect it', async () => {
  let received: ArrayBuffer | undefined, target: UploadTarget | undefined;
  const s = await setup(async (_ctx, t, bytes) => { target=t; received=bytes; return success; });
  s.view.setAttribute(10, 'Name', 'After', 'Before');
  // A distinct same-named model, first in the map and active, with its own edit.
  const otherStore = await parse(new TextEncoder().encode(text).buffer);
  const otherView = new MutablePropertyView(otherStore.properties, 'other'); configureMutationView(otherView, otherStore);
  otherView.setAttribute(10, 'Name', 'Other model', 'Before');
  const other = { ...fixtureModel('other'), name: 'House.ifc', ifcDataStore: otherStore };
  useViewerStore.setState(state => ({ models: new Map([['other', other], ...state.models]), activeModelId: 'other',
    mutationViews: new Map([['other', otherView], ...state.mutationViews]) }));
  const result = await saveSourceModel(s.host,s.binding,destination);
  assert.equal(result.kind,'saved'); assert.ok(received);
  assert.equal((await parse(received)).entities.getName(10),'After');
  assert.deepEqual(target,{mode:'new-version',ref:{projectId:'project',containerId:'folder',fileId:'file'},baseRevisionId:'v1'});
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v2');
  assert.equal(useViewerStore.getState().sourceTags.has('other'),false);
  assert.equal((await parse(editedModelBytes(s.store,s.view).slice().buffer)).entities.getName(10),'After');
});
it('#9522 refuses a swapped model/revision before serializing or writing', async () => {
  let writes=0; const s=await setup(async()=>{writes++;return success;});
  useViewerStore.getState().setSourceTag('m',{...tag,revisionId:'remote-new'});
  assert.deepEqual(await saveSourceModel(s.host,s.binding,destination),{kind:'model-changed'});assert.equal(writes,0);
});
it('#9522 conflicts never advance provenance or retry with a missing base', async () => {
  let writes=0; const s=await setup(async()=>{writes++;return {ok:false,conflict:{kind:'stale-base',currentRevisionId:'v3'}};});
  assert.deepEqual(await saveSourceModel(s.host,s.binding,destination),{kind:'conflict',conflict:{kind:'stale-base',currentRevisionId:'v3'}});
  assert.equal(writes,1);assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v1');
});
it('#9522 an upload completing after unload does not reattach provenance', async () => {
  let finish: (r:UploadResult)=>void = ()=>{throw Error('Upload not started');};
  const s=await setup(async()=>new Promise(resolve=>{finish=resolve;}));
  const pending=saveSourceModel(s.host,s.binding,destination);
  useViewerStore.setState({models:new Map(),sourceTags:new Map()});finish(success);
  assert.deepEqual(await pending,{kind:'saved',result:success,linked:false});assert.equal(useViewerStore.getState().sourceTags.size,0);
});
it('#9522 later edits survive upload completion and are excluded from the already-sent snapshot', async () => {
  let finish: (r:UploadResult)=>void = ()=>{throw Error('Upload not started');};let sent:ArrayBuffer|undefined;
  const s=await setup(async(_ctx,_target,bytes)=>{sent=bytes;return new Promise(resolve=>{finish=resolve;});});
  s.view.setAttribute(10,'Name','Sent','Before');const pending=saveSourceModel(s.host,s.binding,destination);
  s.view.setAttribute(10,'Name','Later','Sent');finish(success);await pending;
  assert.ok(sent);assert.equal((await parse(sent)).entities.getName(10),'Sent');assert.equal((await parse(editedModelBytes(s.store,s.view).slice().buffer)).entities.getName(10),'Later');
});
it('#9522 new-file stays in the original folder; new-location uses the chosen folder', async () => {
  const targets:UploadTarget[]=[];const s=await setup(async(_ctx,target)=>{targets.push(target);return {ok:false,conflict:{kind:'name-exists',existingFileId:'existing'}};});
  await saveSourceModel(s.host,s.binding,{mode:'new-file',containerId:'wrong',fileName:'Copy.ifc'});
  await saveSourceModel(s.host,s.binding,{mode:'new-location',containerId:'chosen',fileName:'Other.ifc'});
  assert.deepEqual(targets,[{mode:'new-file',projectId:'project',containerId:'folder',fileName:'Copy.ifc'},{mode:'new-location',projectId:'project',containerId:'chosen',fileName:'Other.ifc'}]);
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v1');
});
it('#9522 applies declared capability and destination guards before any upload', async () => {
  let writes=0;const s=await setup(async()=>{writes++;return success;});
  assert.deepEqual(await saveSourceModel(s.host,s.binding,{mode:'new-location',containerId:'',fileName:'Bad.ifc'}),{kind:'invalid-destination'});
  assert.deepEqual(await saveSourceModel(s.host,s.binding,{mode:'new-file',containerId:'folder',fileName:'../Bad.ifc'}),{kind:'invalid-destination'});
  s.provider.uploadFile=undefined;
  assert.deepEqual(await saveSourceModel(s.host,s.binding,destination),{kind:'unavailable'});assert.equal(writes,0);
});

it('#9522 successful writes invalidate their cached catalog without clearing another source',async()=>{
  const s=await setup(async()=>success);
  const files=[{id:'file',name:'House.ifc',containerId:'folder',currentRevisionId:'v1'}];
  saveSourceCatalogCache(tag.provider,'project','area',[],files);saveSourceCatalogCache('other','project','area',[],files);
  assert.ok(loadSourceCatalogCache(tag.provider,'project','area'));
  await saveSourceModel(s.host,s.binding,destination);
  assert.equal(loadSourceCatalogCache(tag.provider,'project','area'),null);assert.ok(loadSourceCatalogCache('other','project','area'));
});

it('#9522 a save keeps the signed-in owner stamp that favourites filter on',async()=>{
  const s=await setup(async()=>success);
  syncSourceCatalogCacheOwner(tag.provider,'user-a');
  saveSourceCatalogCache(tag.provider,'project','area',[],[{id:'file',name:'House.ifc',containerId:'folder',currentRevisionId:'v1'}]);
  await saveSourceModel(s.host,s.binding,destination);
  assert.equal(loadSourceCatalogCache(tag.provider,'project','area'),null);
  assert.equal(readSourceCatalogCacheOwner(tag.provider),'user-a');
});
it('#9522 accepts ordinary IFC names and leaves length limits to the provider',async()=>{
  const names:string[]=[];const s=await setup(async(_ctx,target)=>{if(target.mode!=='new-version')names.push(target.fileName);return success;});
  const long=`${'Long model name '.repeat(5)}.ifc`;
  for(const fileName of ['Haus (Rev 3) & Co.ifc',long]){
    assert.equal((await saveSourceModel(s.host,bindSourceModel('m')!,{mode:'new-file',containerId:'folder',fileName})).kind,'saved',fileName);
  }
  assert.deepEqual(names,['Haus (Rev 3) & Co.ifc',long]);
  for(const fileName of [' padded.ifc','a\\b.ifc','.ifc','House.step']){
    assert.deepEqual(await saveSourceModel(s.host,bindSourceModel('m')!,{mode:'new-file',containerId:'folder',fileName}),{kind:'invalid-destination'},fileName);
  }
});

it('#9522 forwards the caller\'s abort signal so a stalled upload can be cancelled',async()=>{
  let seen:AbortSignal|undefined;const s=await setup(async(_ctx,_target,_bytes,options)=>{seen=options?.signal;return success;});
  const controller=new AbortController();
  await saveSourceModel(s.host,s.binding,destination,controller.signal);
  assert.equal(seen,controller.signal);
});

it('#9522 a model that follows a newly created file takes that file\'s name; a new version keeps it',async()=>{
  const created:UploadResult={ok:true,file:{id:'copy',containerId:'folder',name:'House-edited.ifc',currentRevisionId:'c1'},revision:{id:'c1',label:'1',createdAt:'2026-11-26'}};
  const s=await setup(async(_ctx,target)=>target.mode==='new-version'?{...created,revision:{...created.revision,id:'c2'}}:created);
  await saveSourceModel(s.host,s.binding,{mode:'new-file',containerId:'folder',fileName:'House-edited.ifc'});
  assert.equal(useViewerStore.getState().models.get('m')?.name,'House-edited.ifc');
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.fileId,'copy');
  await saveSourceModel(s.host,bindSourceModel('m')!,destination);
  assert.equal(useViewerStore.getState().models.get('m')?.name,'House-edited.ifc');
});

it('#11650 renames a model that follows the same file ID in a different container', async () => {
  const s = await setup(async () => ({
    ...success,
    file: { ...success.file, containerId: '', name: 'Moved.ifc' },
  }));
  await saveSourceModel(s.host, s.binding, { mode: 'new-location', containerId: 'chosen', fileName: 'Moved.ifc' });
  const state = useViewerStore.getState();
  assert.equal(state.sourceTags.get('m')?.containerId, 'chosen');
  assert.equal(state.sourceTags.get('m')?.fileId, tag.fileId);
  assert.equal(state.models.get('m')?.name, 'Moved.ifc');
});

it('#9522 a failed or cancelled upload still drops the cached listing, since the write may have landed',async()=>{
  const s=await setup(async()=>{throw new DOMException('cancelled','AbortError');});
  syncSourceCatalogCacheOwner(tag.provider,'user-a');
  saveSourceCatalogCache(tag.provider,'project','area',[],[{id:'file',name:'House.ifc',containerId:'folder',currentRevisionId:'v1'}]);
  await assert.rejects(saveSourceModel(s.host,s.binding,destination),/cancelled/);
  assert.equal(loadSourceCatalogCache(tag.provider,'project','area'),null);
  assert.equal(readSourceCatalogCacheOwner(tag.provider),'user-a');
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v1');
});
it('#9522 an empty container from the provider keeps the requested one; an empty revision never relinks',async()=>{
  const results:UploadResult[]=[
    {ok:true,file:{id:'copy',containerId:'',name:'Copy.ifc',currentRevisionId:'c1'},revision:{id:'c1',label:'1',createdAt:''}},
    {ok:true,file:{id:'copy',containerId:'chosen',name:'Copy.ifc',currentRevisionId:''},revision:{id:'',label:'',createdAt:''}},
  ];
  const s=await setup(async()=>results.shift()!);
  assert.equal((await saveSourceModel(s.host,s.binding,{mode:'new-location',containerId:'chosen',fileName:'Copy.ifc'})).kind,'saved');
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.containerId,'chosen');
  const before=useViewerStore.getState().sourceTags.get('m');
  const outcome=await saveSourceModel(s.host,bindSourceModel('m')!,{mode:'new-location',containerId:'chosen',fileName:'Copy.ifc'});
  assert.equal(outcome.kind==='saved'&&outcome.linked,false);
  assert.deepEqual(useViewerStore.getState().sourceTags.get('m'),before);
});
