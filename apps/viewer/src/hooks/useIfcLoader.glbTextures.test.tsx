/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { prepareGlbViewerModel } from './ingest/glbTextureValidation.js';
import { useIfcLoader } from './useIfcLoader.js';

// Real PNG and GLB framing; only the browser image decoder/canvas are replaced.
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
function fixture(mimeType = 'image/png', image = png): File {
  const positions=new Float32Array([0,0,0,1,0,0,0,1,0]); const uv=new Float32Array([0,0,1,0,0,1]);
  const data=new Uint8Array(positions.byteLength+uv.byteLength+image.length);data.set(new Uint8Array(positions.buffer));data.set(new Uint8Array(uv.buffer),positions.byteLength);data.set(image,positions.byteLength+uv.byteLength);
  const json={asset:{version:'2.0'},nodes:[{mesh:0,extras:{expressId:42}}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],textures:[{source:0}],images:[{mimeType,bufferView:2}],buffers:[{byteLength:data.length}],bufferViews:[{buffer:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:uv.byteLength},{buffer:0,byteOffset:positions.byteLength+uv.byteLength,byteLength:image.length}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'},{bufferView:1,componentType:5126,count:3,type:'VEC2'}]};
  const text=new TextEncoder().encode(JSON.stringify(json));const textLength=Math.ceil(text.length/4)*4,binLength=Math.ceil(data.length/4)*4;const bytes=new Uint8Array(28+textLength+binLength);const view=new DataView(bytes.buffer);view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,bytes.length,true);view.setUint32(12,textLength,true);view.setUint32(16,0x4e4f534a,true);bytes.fill(32,20,20+textLength);bytes.set(text,20);view.setUint32(20+textLength,binLength,true);view.setUint32(24+textLength,0x004e4942,true);bytes.set(data,28+textLength);return new File([bytes],'capture.glb');
}
class OpaqueCanvas {
  width = 1;
  getContext() {
    return {
      clearRect() {}, drawImage() {},
      getImageData() { return { data: new Uint8ClampedArray([255, 0, 0, 255]) }; },
    };
  }
}
const oldDecoder=globalThis.createImageBitmap, oldCanvas=globalThis.OffscreenCanvas;
afterEach(()=>{Object.defineProperty(globalThis,'createImageBitmap',{value:oldDecoder,configurable:true,writable:true});Object.defineProperty(globalThis,'OffscreenCanvas',{value:oldCanvas,configurable:true,writable:true});useViewerStore.getState().resetViewerState();useViewerStore.getState().clearAllModels();});

it('#4380 canonical primary and federated GLB loads retain UVs, independent texture IDs and original bytes until last model removal',async()=>{
  let closed=0;
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async()=>({width:1,height:1,close(){closed++;}})});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,writable:true,value:OpaqueCanvas});
  useViewerStore.getState().resetViewerState();useViewerStore.getState().clearAllModels();
  let api:ReturnType<typeof useIfcLoader>|undefined;function Probe(){api=useIfcLoader();return null;}
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<Probe/>));
    await act(async()=>api!.loadFile(fixture()));
    const primary=[...useViewerStore.getState().models.values()][0];assert.ok(primary?.geometryResult);assert.equal(primary.loadState,'complete');
    const first=primary.geometryResult.meshes[0];assert.deepEqual([...first.uvs!],[0,0,1,0,0,1]);assert.ok(first.textureBitmap);assert.deepEqual(modelAppearanceAssets.exportOriginals(primary.id).resources.get('textures/glb-image-0.png'),png);
    await act(async()=>api!.loadFile(fixture(),{kind:'federated',modelId:'second-capture'}));
    const second=useViewerStore.getState().models.get('second-capture');assert.ok(second?.geometryResult);assert.notEqual(second.loadState,'error');
    const other=second.geometryResult.meshes[0];assert.notEqual(other.expressId,first.expressId);assert.notEqual(other.textureRef!.textureId,first.textureRef!.textureId);assert.strictEqual(other.textureBitmap,first.textureBitmap);
    assert.deepEqual(modelAppearanceAssets.exportOriginals(second.id).resources.get('textures/glb-image-0.png'),png);
    useViewerStore.getState().removeModel(primary.id);assert.equal(closed,0,'shared image survives the remaining model');
    useViewerStore.getState().removeModel(second.id);assert.equal(closed,1,'last source releases the shared bitmap exactly once');
  } finally {await act(async()=>root.unmount());host.remove();}
});

it('#4380 a superseded pending image decode cannot replace the newer GLB or report its cancellation as a load error',async()=>{
  let releaseFirst:((bitmap: {width:number;height:number;close():void})=>void)|undefined;
  let started:()=>void=()=>{};const decoding=new Promise<void>(resolve=>{started=resolve;});let count=0,closed=0;
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async()=>{
    if (++count===1) {started();return new Promise(resolve=>{releaseFirst=resolve;});}
    return {width:1,height:1,close(){closed++;}};
  }});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,writable:true,value:OpaqueCanvas});
  useViewerStore.getState().resetViewerState();useViewerStore.getState().clearAllModels();
  let api:ReturnType<typeof useIfcLoader>|undefined;function Probe(){api=useIfcLoader();return null;}
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<Probe/>));
    await act(async()=>{
      const oldLoad=api!.loadFile(fixture());await decoding;
      await api!.loadFile(fixture());
      releaseFirst!({width:1,height:1,close(){closed++;}});
      await oldLoad;
    });
    const models=[...useViewerStore.getState().models.values()];assert.equal(models.length,1);assert.equal(models[0].loadState,'complete');assert.ok(models[0].geometryResult?.meshes[0].textureBitmap);assert.equal(useViewerStore.getState().error,null);assert.equal(closed,1,'only stale decoder result is closed');
  } finally {await act(async()=>root.unmount());host.remove();}
});


it('#4380 rejects a transparent PNG declared as JPEG before opacity fast-path or asset decode', async () => {
  // Real one-pixel RGBA PNG with alpha=0; its GLB MIME intentionally lies.
  const transparent = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DAAAAEAQEARwbK3gAAAABJRU5ErkJggg==', 'base64'));
  let decodes = 0;
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async () => {
    decodes++; return { width: 1, height: 1, close() {} };
  } });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: class {
    constructor() { throw new Error('A forged JPEG currently skips opacity readback'); }
  } });
  const lease = modelAppearanceAssets.begin('forged-jpeg');
  try {
    await assert.rejects(prepareGlbViewerModel(await fixture('image/jpeg', transparent).arrayBuffer(),
      archive => lease.decode(archive), () => false), /image.*signature.*MIME/i);
    assert.equal(decodes, 0, 'Cache boundary rejects before image resource allocation');
  } finally { lease.cancel(); }
});
