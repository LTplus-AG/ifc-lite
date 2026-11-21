/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { PLUGIN_API_VERSION, type FileSourceProvider, type UploadResult } from '@ifc-lite/plugin-api';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { SourceWriteBackModels } from './SourceWriteBackAction';
import { SourceWriteBackDialog } from './SourceWriteBackDialog';

const result: UploadResult = { ok:true, file:{id:'file',name:'House.ifc',containerId:'folder',currentRevisionId:'v2'},revision:{id:'v2',label:'Uploaded revision',createdAt:'2026-11-15'} };
async function setup(upload: NonNullable<FileSourceProvider['uploadFile']>) {
  const bytes=new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#10=IFCWALL('0Wall00000000000000010',$,'Wall',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;");
  const store=await new IfcParser().parseColumnar(bytes.buffer,{disableWorkerScan:true});
  useViewerStore.setState({...fixtureModels({...fixtureModel('m'),name:'House.ifc',ifcDataStore:store}),mutationViews:new Map(),sourceTags:new Map([['m',{provider:'writeback-ui',projectId:'project',containerId:'folder',fileId:'file',revisionId:'v1',loadedAt:1}]])});
  const source:FileSourceProvider={manifest:{name:'writeback-ui',title:'UI source',api:PLUGIN_API_VERSION,auth:'preferences',permissions:{network:['source.example']},preferences:[],contributes:{fileSources:['./provider.ts']},capabilities:{containerListing:'direct-children',listFilesIsRecursive:false,revisionHistory:true,downloadHistoricalRevisions:false,changeDetection:false,search:false,writeBack:['new-version','new-file','new-location']}},
    listProjects:async()=>({items:[]}),listContainers:async()=>({items:[{id:'destination',name:'Chosen folder'}]}),listFiles:async()=>({items:[]}),download:async()=>{throw Error('No implicit download');},uploadFile:upload,
    listRevisions:async()=>({items:[{id:'v2',label:'Uploaded revision',createdAt:'2026-11-15'},{id:'v1',label:'Older history entry',createdAt:'2026-11-14'}]})};
  return source;
}
async function flush() { await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));}); }
function button(label:string):HTMLButtonElement {
  const node=[...document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(node,`Missing button ${label}`);return node;
}
function confirm() { const checkbox=document.querySelector<HTMLInputElement>('input[type=checkbox]');assert.ok(checkbox);click(checkbox); }
afterEach(()=>{cleanup();useViewerStore.setState({models:new Map(),sourceTags:new Map(),mutationViews:new Map()});});

it('#9522 keeps local/read-only sources hidden and offers a write action for one loaded model',async()=>{
  const source=await setup(async()=>result);
  source.uploadFile=undefined;
  let ui=render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackModels /></SourceHostProvider>);
  assert.equal(ui.querySelector('button'),null);cleanup();
  source.uploadFile=async()=>result;
  ui=render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackModels /></SourceHostProvider>);
  assert.equal(ui.querySelector('button')?.getAttribute('aria-label'),'Save House.ifc to source');
  await act(async()=>{useViewerStore.getState().clearSourceTags();});assert.equal(ui.querySelector('button'),null);
});
it('#9522 opening a dialog never writes; confirmation sends once and shows the created revision/history',async()=>{
  let writes=0;const source=await setup(async()=>{writes++;return result;});
  render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackDialog modelId="m" onClose={()=>{}} /></SourceHostProvider>);
  assert.equal(writes,0);assert.equal(button('Confirm and save').disabled,true);
  confirm();click(button('Confirm and save'));await flush();
  assert.equal(writes,1);assert.match(document.body.textContent??'',/Uploaded revision/);assert.match(document.body.textContent??'',/Older history entry/);
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v2');
});
it('#9522 exposes a stale-base conflict without a retry or provenance change',async()=>{
  let writes=0;const source=await setup(async()=>{writes++;return {ok:false,conflict:{kind:'stale-base',currentRevisionId:'v3'}};});
  render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackDialog modelId="m" onClose={()=>{}} /></SourceHostProvider>);
  confirm();click(button('Confirm and save'));await flush();
  assert.equal(writes,1);assert.match(document.body.textContent??'',/source has a newer revision/);assert.equal(button('Confirm and save').disabled,true);
  assert.equal(useViewerStore.getState().sourceTags.get('m')?.revisionId,'v1');
});
it('#9522 model replacement while the dialog is open disables outward writing',async()=>{
  let writes=0;const source=await setup(async()=>{writes++;return result;});
  render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackDialog modelId="m" onClose={()=>{}} /></SourceHostProvider>);
  confirm();await act(async()=>{useViewerStore.setState({models:new Map()});});
  assert.equal(button('Confirm and save').disabled,true);click(button('Confirm and save'));await flush();assert.equal(writes,0);
});
it('#9522 new-location requires an actual chosen provider folder and renewed confirmation',async()=>{
  let target:Parameters<NonNullable<FileSourceProvider['uploadFile']>>[1]|undefined;
  const source=await setup(async(_ctx,value)=>{target=value;return result;});
  render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackDialog modelId="m" onClose={()=>{}} /></SourceHostProvider>);
  confirm();click(button('A new file in another folder'));await flush();
  assert.equal(button('Confirm and save').disabled,true);
  click(button('Chosen folder'));await flush();click(button('Use this folder'));confirm();click(button('Confirm and save'));await flush();
  assert.deepEqual(target,{mode:'new-location',projectId:'project',containerId:'destination',fileName:'House-edited.ifc'});
});

it('#9522 the loaded-model action opens the global dialog through the real source host',async()=>{
  let writes=0;const source=await setup(async()=>{writes++;return result;});
  const ui=render(<SourceHostProvider additionalProviders={[()=>source]}><SourceWriteBackModels /></SourceHostProvider>);
  const action=ui.querySelector('button');assert.ok(action);click(action);
  for(let attempt=0;attempt<100&&!document.querySelector('[role="dialog"]');attempt++)await flush();
  assert.ok(document.querySelector('[role="dialog"]'),'The actual model action opens Save to source');
  assert.equal(button('Confirm and save').disabled,true);assert.equal(writes,0);
});
