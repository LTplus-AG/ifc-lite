/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual exported-model selection and visibility acceptance in a fresh browser.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const out=process.env.EVALUATED_OUT??'/tmp/evaluated-ui-browser';
const target=process.env.EVALUATED_REOPEN??out+'/AC20-FZK-Haus_export.ifczip';
const federated=process.env.EVALUATED_FEDERATED==='1';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
try {
 await page.goto('http://127.0.0.1:4376/');
 await page.evaluate(async()=>{window.__store=(await import('/src/store/index.ts')).useViewerStore;});
 await page.locator('#file-input-open').setInputFiles(federated?[process.cwd()+'/tests/models/ara3d/AC20-FZK-Haus.ifc',target]:target);
 await page.waitForFunction(count=>{const s=window.__store.getState();return s.models.size===count&&!s.isLoading&&[...s.models.values()].every(m=>m.ifcDataStore&&m.geometryResult);},federated?2:1,{timeout:120000});
 const before=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(e=>e.name).filter(name=>name.includes('/src/hooks/useBCF.ts')).at(-1);
  const api=await import(url??'/src/hooks/useBCF.ts');let r=api.getGlobalRenderer();
  for(let i=0;!r&&i<100;i++){await new Promise(resolve=>setTimeout(resolve,100));r=api.getGlobalRenderer();}
  if(!r)throw Error('No renderer');window.__renderer=r;
  const s=window.__store.getState(),m=[...s.models.values()].at(-1),id=s.toGlobalId(m.id,35169),sibling=s.toGlobalId(m.id,35304);
  window.__targetModel=m.id;window.__targetId=id;window.__siblingId=sibling;
  s.setIsolatedEntities(new Set([id]));s.setSelectedEntityId(null);s.setSelectedEntity(null);s.setSelectedEntityIds([]);
  const scene=r.getScene(),box=scene.getEntityBoundingBox(id);if(!box)throw Error('No exported owner bounds');
  r.getCamera().fitToBounds(box.min,box.max);r.requestRender();
  return {id,model:m.id,hasGeometry:m.ifcDataStore.entities.hasGeometry(35169),siblingHasGeometry:m.ifcDataStore.entities.hasGeometry(35304),parts:scene.getMeshDataPieces(id)?.map(p=>({item:p.geometryItemId,textured:!!p.textureRef||!!p.texture,triangles:p.indices.length/3})),instance:!!scene.getInstancedMeshDataPieces(id),sibling:!!scene.getInstancedMeshDataPieces(sibling)};
 });
 if(target.endsWith('.ifczip')){assert.equal(before.parts.length,1);assert.equal(before.parts[0].textured,true);assert.equal(before.instance,false);}
 await page.waitForTimeout(300);
 const point=await page.evaluate(()=>{const r=window.__renderer,box=r.getScene().getEntityBoundingBox(window.__targetId),canvas=r.getCanvas(),rect=canvas.getBoundingClientRect();const p=r.getCamera().projectToScreen({x:(box.min.x+box.max.x)/2,y:(box.min.y+box.max.y)/2,z:(box.min.z+box.max.z)/2},rect.width,rect.height);return{x:rect.left+p.x,y:rect.top+p.y};});
 await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>window.__store.getState().selectedEntityId===window.__targetId,undefined,{timeout:10000});
 await page.screenshot({path:out+'/reopened-selected.png'});
 const read=()=>page.evaluate(()=>{const scene=window.__renderer.getScene();return{flat:scene.getMeshDataPieces(window.__targetId)?.length??0,instance:!!scene.getInstancedMeshDataPieces(window.__targetId),sibling:!!scene.getInstancedMeshDataPieces(window.__siblingId)};});
 await page.evaluate(()=>window.__store.getState().setModelVisibility(window.__targetModel,false));await page.waitForTimeout(200);const hidden=await read();
 await page.screenshot({path:out+'/model-hidden.png'});
 await page.evaluate(()=>{const s=window.__store.getState();s.setSelectedEntityId(null);s.setSelectedEntity(null);s.setSelectedEntityIds([]);});
 await page.mouse.click(point.x,point.y);await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.__store.getState().selectedEntityId),null,'hidden model cannot be selected through the viewport');
 await page.evaluate(()=>window.__store.getState().setModelVisibility(window.__targetModel,true));await page.waitForTimeout(200);const shown=await read();
 if(process.env.EVALUATED_REQUIRE_RESTORE==='1'){await page.mouse.click(point.x,point.y);await page.waitForFunction(()=>window.__store.getState().selectedEntityId===window.__targetId,undefined,{timeout:10000});}
 await page.screenshot({path:out+'/model-shown.png'});
 fs.writeFileSync(out+'/reopen-visibility.json',JSON.stringify({before,hidden,shown,actualViewportSelection:true},null,2));
 console.log('REOPEN_SELECTED_VISIBILITY',JSON.stringify({before,hidden,shown}));
} finally {fs.writeFileSync(out+'/reopen-state.json',JSON.stringify(await page.evaluate(()=>{const s=window.__store?.getState();return s?{isLoading:s.isLoading,models:[...s.models.values()].map(m=>({name:m.name,state:m.loadState,data:!!m.ifcDataStore,geometry:!!m.geometryResult}))}:null;}),null,2));await page.screenshot({path:out+'/reopen-last.png'}).catch(error=>console.error(error));await browser.close();}
