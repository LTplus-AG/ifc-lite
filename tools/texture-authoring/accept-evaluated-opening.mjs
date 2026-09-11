/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual real AC20 post-opening appearance, companion history and export acceptance.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const federated=process.env.OPENING_FEDERATED==='1';
const shown=process.env.OPENING_SHOWN==='1', out=process.env.OPENING_OUT??`/tmp/opening-${shown?'shown':'hidden'}`;
fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});page.setDefaultTimeout(30000);
page.on('console',message=>fs.appendFileSync(path.join(out,'console.log'),message.text()+'\n'));
page.on('pageerror',error=>fs.appendFileSync(path.join(out,'errors.log'),String(error)+'\n'));
try {
 await page.addInitScript(()=>performance.setResourceTimingBufferSize(10000));
 await page.goto(process.env.OPENING_URL??'http://127.0.0.1:4386/');
 await page.evaluate(async()=>{window.__store=(await import('/src/store/index.ts')).useViewerStore;});
 await page.locator('#file-input-open').setInputFiles(federated ? [path.resolve('tests/models/ara3d/AC20-FZK-Haus.ifc'),'/tmp/evaluated-ui-federated-baseline/AC20-second.ifc'] : path.resolve('tests/models/ara3d/AC20-FZK-Haus.ifc'));
 await page.waitForFunction(count=>{const s=window.__store.getState();return s.models.size===count&&!s.isLoading&&[...s.models.values()].every(m=>m.ifcDataStore&&m.geometryResult&&(!m.loadState||m.loadState==='complete'));},federated?2:1,{timeout:120000});
 const loaded=await page.evaluate(async shown=>{
  const urls=performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.includes('/src/hooks/useBCF.ts'));
  let r;
  for(let i=0;!r&&i<100;i++) {
   for(const url of [...urls,'/src/hooks/useBCF.ts']) {const module=await import(url);r=module.getGlobalRenderer();if(r)break;}
   if(!r)await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!r)throw new Error('Renderer missing');window.__renderer=r;
  const s=window.__store.getState(),m=[...s.models.values()].at(-1),host=s.toGlobalId(m.id,59290),opening=s.toGlobalId(m.id,59365);
  window.__model=m.id;window.__host=host;window.__opening=opening;
  if(s.typeVisibility.openings!==shown)s.toggleTypeVisibility('openings');
  s.setSelectedEntityId(host);s.setSelectedEntity({modelId:m.id,expressId:59290});s.setIsolatedEntities(new Set([host,opening]));
  const box=r.getScene().getEntityBoundingBox(host);if(!box)throw new Error('Host bounds missing');
  r.getCamera().fitToBounds(box.min,box.max);r.requestRender();
  return {model:m.id,host,opening};
 },shown);
 if(shown)await page.waitForFunction(()=>window.__renderer.getScene().getMeshDataPieces(window.__opening)?.length===1,undefined,{timeout:20000});
 const snapshot=()=>page.evaluate(()=>{
  const s=window.__store.getState(),m=s.models.get(window.__model),scene=window.__renderer.getScene();
  const mesh=id=>(scene.getMeshDataPieces(id)??[]).map(p=>({item:p.geometryItemId,positions:[...p.positions],indices:[...p.indices],origin:p.origin,textured:!!p.textureRef||!!p.texture}));
  return {host:mesh(window.__host),opening:mesh(window.__opening),modelOpening:m.geometryResult.meshes.filter(p=>p.expressId===window.__opening).length,
   modelOpeningGeometry:m.geometryResult.meshes.filter(p=>p.expressId===window.__opening).map(p=>({item:p.geometryItemId,positions:[...p.positions],indices:[...p.indices],origin:p.origin})),
   selected:s.selectedEntityId,openingsShown:s.typeVisibility.openings,undo:s.undoStacks.get(m.id)?.length??0,redo:s.redoStacks.get(m.id)?.length??0};
 });
 const before=await snapshot();fs.writeFileSync(path.join(out,'before.json'),JSON.stringify(before,null,2));assert.equal(before.opening.length,shown?1:0);assert.equal(before.host[0].indices.length/3,32);
 await page.getByRole('tab',{name:'Author',exact:true}).click();await page.getByRole('button',{name:'Appearance',exact:true}).click();
 const panel=page.getByLabel('Appearance workspace');await panel.waitFor();
 if(federated)await panel.getByLabel('Appearance model',{exact:true}).selectOption(loaded.model);
 await panel.getByLabel('Upload appearance source',{exact:true}).setInputFiles('/tmp/ifclite-public-captures/derived/boulder-512.png');
 await page.getByRole('checkbox',{name:/Convert supported objects to mesh/}).check();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance workspace"]')?.textContent.match(/Preview ready|Opening companion geometry changed/),undefined,{timeout:120000});
 console.log('PREVIEW_STATUS',await panel.innerText());
 const preview=await snapshot();assert.equal(preview.opening.length,0);assert.equal(preview.modelOpening,1);
 await page.screenshot({path:path.join(out,'preview.png')});
 await panel.getByRole('button',{name:'Compare original',exact:true}).click();
 const compared=await snapshot();assert.deepEqual(compared.opening,before.opening);
 await panel.getByRole('button',{name:'Show preview',exact:true}).click();await panel.getByRole('button',{name:'Apply',exact:true}).click();
 await page.waitForFunction(()=>window.__store.getState().undoStacks.get(window.__model)?.length===1,undefined,{timeout:60000});
 const applied=await snapshot();assert.equal(applied.opening.length,0);assert.equal(applied.modelOpening,0);assert.equal(applied.host[0].textured,true);
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 const undone=await snapshot();assert.deepEqual(undone.opening,before.opening);assert.deepEqual(undone.modelOpeningGeometry,before.modelOpeningGeometry);assert.equal(undone.modelOpening,1);assert.equal(undone.openingsShown,shown);
 await page.screenshot({path:path.join(out,'undone.png')});
 if(!shown) {
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await page.evaluate(()=>window.__store.getState().toggleTypeVisibility('openings'));await page.waitForTimeout(150);
  assert.equal((await snapshot()).opening.length,0);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await page.waitForFunction(()=>window.__renderer.getScene().getMeshDataPieces(window.__opening)?.length===1);
 }
 const shownUndo=await snapshot();assert.equal(shownUndo.opening.length,1);

 const clickPoint=await page.evaluate(()=>{
  const s=window.__store.getState(),r=window.__renderer;s.clearEntitySelection();s.setIsolatedEntities(new Set([window.__opening]));
  const box=r.getScene().getEntityBoundingBox(window.__opening),rect=r.getCanvas().getBoundingClientRect();
  r.getCamera().fitToBounds(box.min,box.max);r.requestRender();
  const p=r.getCamera().projectToScreen({x:(box.min.x+box.max.x)/2,y:(box.min.y+box.max.y)/2,z:(box.min.z+box.max.z)/2},rect.width,rect.height);
  return {x:rect.left+p.x,y:rect.top+p.y};
 });
 await page.waitForTimeout(200);await page.mouse.click(clickPoint.x,clickPoint.y);await page.waitForTimeout(150);
 const openingClick=await page.evaluate(()=>window.__store.getState().selectedEntityId);
 assert.equal(openingClick,loaded.opening);
 await page.screenshot({path:path.join(out,'undo-opening-click.png')});
 await page.evaluate(()=>{const s=window.__store.getState();s.setIsolatedEntities(new Set([window.__host,window.__opening]));s.setSelectedEntityId(window.__host);s.setSelectedEntity({modelId:window.__model,expressId:59290});});
 await page.getByRole('button',{name:'Redo',exact:true}).click();
 if(!shown){await page.evaluate(()=>window.__store.getState().toggleTypeVisibility('openings'));await page.waitForTimeout(100);}
 const redone=await snapshot();assert.deepEqual(redone,applied);
 await page.evaluate(()=>{window.__store.getState().clearEntitySelection();window.__renderer.requestRender();});await page.waitForTimeout(150);
 await page.screenshot({path:path.join(out,'applied.png')});
 fs.writeFileSync(path.join(out,'journey.json'),JSON.stringify({shown,federated,loaded,before,preview,compared,applied,undone,shownUndo,openingClick,redone},null,2));
 await page.getByRole('tab',{name:'File',exact:true}).click();await page.getByRole('button',{name:'Export IFC (with changes)',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Export IFC File'});await dialog.waitFor();
 if(federated){await dialog.getByRole('combobox').filter({hasText:'AC20-FZK-Haus.ifc'}).click();await page.getByRole('option',{name:/AC20-second.ifc/}).click();}
 const downloading=page.waitForEvent('download');
 await dialog.getByRole('button',{name:'Export',exact:true}).click();const download=await downloading;assert.match(download.suggestedFilename(),/\.ifczip$/);
 await download.saveAs(path.join(out,download.suggestedFilename()));console.log('OPENING_JOURNEY_PASS',out);
} finally {
 fs.writeFileSync(path.join(out,'last.txt'),await page.locator('body').innerText());
 await page.screenshot({path:path.join(out,'last.png')}).catch(error=>console.error(error));await browser.close();
}
