/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { CapturePreview } from './CapturePreview';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==','base64'));
const owner = { kind: 'source' as const, id:'capture-preview-fixture' };
const mesh: MeshData = {expressId:1,positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2]),uvs:new Float32Array([0,0,1,0,0,1]),color:[1,1,1,1],textureRef:{textureId:1,url:'a.png',repeatS:false,repeatT:false}};
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});}
afterEach(()=>{cleanup();appearanceAssets.releaseOwner(owner);mock.restoreAll();});
async function transport(){
  const asset=await appearanceAssets.add(png,{owner});
  mock.method(appearanceAssets,'decode',async()=>({width:1,height:1,close(){}}));
  mock.method(Renderer.prototype,'init',async()=>{});
  mock.method(Renderer.prototype,'loadGeometry',()=>{});
  mock.method(Renderer.prototype,'render',()=>{});
  mock.method(Renderer.prototype,'fitToView',()=>{});
  return asset;
}

test('capture preview GPU loss disables authoring and supports a fresh renderer retry (#4380)',async()=>{
  const asset=await transport();let lost:(info:{message:string;reason:string})=>void=()=>{};let disposed=0;
  mock.method(Renderer.prototype,'onDeviceLost',(listener:typeof lost)=>{lost=listener;return()=>{};});
  mock.method(Renderer.prototype,'destroy',()=>{disposed++;});
  function Panel(){const[ready,setReady]=useState(false),[error,setError]=useState('');return <><CapturePreview mesh={mesh} assetId={asset.id} triangles={[0]} disabled={false} onRegion={()=>{}} onReady={setReady} onError={setError}/><button disabled={!ready}>Create</button><output>{error}</output></>;}
  const ui=render(<Panel/>);await settle();
  const create=()=>[...ui.querySelectorAll('button')].find(b=>b.textContent==='Create')!;
  assert.equal(create().disabled,false);
  act(()=>lost({message:'test GPU loss',reason:'unknown'}));await settle();
  assert.equal(create().disabled,true);assert.match(ui.textContent!,/connection was lost/);assert.ok(disposed>0);
  click([...ui.querySelectorAll('button')].find(b=>b.textContent==='Reload preview')!);await settle();
  assert.equal(create().disabled,false);assert.deepEqual(appearanceAssets.encoded(asset.id),png);
});

test('closing capture preview during renderer initialization cannot upload to a discarded view (#4380)',async()=>{
  const asset=await transport();let finish:()=>void=()=>{};let uploads=0;
  mock.method(Renderer.prototype,'init',()=>new Promise<void>(resolve=>{finish=resolve;}));
  mock.method(Renderer.prototype,'loadGeometry',()=>{uploads++;});
  const ready:boolean[]=[];
  render(<CapturePreview mesh={mesh} assetId={asset.id} triangles={[0]} disabled={false} onRegion={()=>{}} onReady={value=>ready.push(value)} onError={()=>{}}/>);
  await settle();cleanup();await act(async()=>{finish();});await settle();
  assert.equal(uploads,0);assert.equal(ready.includes(true),false);
  appearanceAssets.releaseOwner(owner);assert.equal(appearanceAssets.get(asset.id),undefined,'abandoned initialization retains no hidden image lease');
});
