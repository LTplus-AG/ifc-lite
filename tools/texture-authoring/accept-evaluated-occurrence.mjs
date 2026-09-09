/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual real-model acceptance; run against an isolated local viewer session.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=process.env.EVALUATED_OUT ?? '/tmp/evaluated-ui-browser';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});page.setDefaultTimeout(30000);
page.on('console',message=>fs.appendFileSync(path.join(out,'console.log'),message.text()+'\n'));
page.on('pageerror',error=>fs.appendFileSync(path.join(out,'errors.log'),String(error)+'\n'));
try {
  await page.goto(process.env.EVALUATED_URL ?? 'http://127.0.0.1:4376/');
  await page.evaluate(async()=>{window.__evaluatedStore=(await import('/src/store/index.ts')).useViewerStore;});
  await page.locator('#file-input-open').setInputFiles(process.env.EVALUATED_IFC ?? path.resolve('tests/models/ara3d/AC20-FZK-Haus.ifc'));
  await page.waitForFunction(()=>{const s=window.__evaluatedStore.getState();return s.models.size===1&&!s.isLoading&&[...s.models.values()][0].loadState==='complete';},undefined,{timeout:120000});
  const loaded=await page.evaluate(async()=>{
    const moduleUrl=performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.includes('/src/hooks/useBCF.ts')).at(-1);
    const {getGlobalRenderer}=await import(moduleUrl ?? '/src/hooks/useBCF.ts');
    let renderer=getGlobalRenderer();
    for(let attempt=0;!renderer&&attempt<100;attempt++) { await new Promise(resolve=>setTimeout(resolve,100)); renderer=getGlobalRenderer(); }
    if(!renderer) throw new Error('Viewport renderer did not become available');
    window.__evaluatedRenderer=renderer;
    const s=window.__evaluatedStore.getState(),model=[...s.models.values()][0],id=s.toGlobalId(model.id,35169);
    s.setSelectedEntityId(id);s.setSelectedEntity({modelId:model.id,expressId:35169});s.setIsolatedEntities(new Set([id]));
    const scene=renderer.getScene();
    const parts=scene.getMeshDataPieces(id) ?? [];
    const instanceBounds=scene.getInstancedEntityBounds(id);
    const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
    for(const mesh of parts)for(let i=0;i<mesh.positions.length;i+=3)for(const [a,k] of ['x','y','z'].entries()){
      const value=mesh.positions[i+a]+(mesh.origin?.[a]??0);min[k]=Math.min(min[k],value);max[k]=Math.max(max[k],value);
    }
    if(parts.length) renderer.getCamera().fitToBounds(min,max);
    else if(instanceBounds) renderer.getCamera().fitToBounds(instanceBounds.min,instanceBounds.max);
    renderer.requestRender();
    return {modelId:model.id,globalId:id,instanceBounds,parts:parts.map(p=>({geometryItemId:p.geometryItemId,vertices:p.positions.length/3,triangles:p.indices.length/3,provenance:p.appearanceSource?.kind})),min,max};
  });
  fs.writeFileSync(path.join(out,'loaded.json'),JSON.stringify(loaded,null,2));
  await page.getByRole('tab',{name:'Author',exact:true}).click();
  await page.getByRole('button',{name:'Appearance',exact:true}).click();
  const panel=page.getByLabel('Appearance workspace');await panel.waitFor();
  await panel.locator('input[type=file]').setInputFiles(process.env.EVALUATED_IMAGE ?? '/tmp/ifclite-public-captures/derived/boulder-512.png');
  await page.waitForFunction(()=>/mapped occurrence|Only direct/.test(document.querySelector('[aria-label="Appearance workspace"]')?.textContent??''),undefined,{timeout:30000}).catch(async error=>{
    const text=await panel.innerText();if(!/support|representation|tessellat/i.test(text))throw error;
  });
  fs.writeFileSync(path.join(out,'preserve.txt'),await panel.innerText());
  await page.screenshot({path:path.join(out,'preserve.png')});
  await page.getByRole('checkbox',{name:/Convert supported mapped objects/}).check();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance workspace"]')?.textContent.includes('Preview ready'),undefined,{timeout:120000});
  await page.screenshot({path:path.join(out,'preview.png')});
  fs.writeFileSync(path.join(out,'preview.txt'),await panel.innerText());
  console.log('PREVIEW_READY',JSON.stringify(loaded));
  const snapshot=()=>page.evaluate(()=>{
    const s=window.__evaluatedStore.getState(),m=[...s.models.values()][0],scene=window.__evaluatedRenderer.getScene();
    const id=s.toGlobalId(m.id,35169),sibling=s.toGlobalId(m.id,35304);
    return { selected:s.selectedEntityId, flat:scene.getMeshDataPieces(id)?.map(p=>({item:p.geometryItemId,triangles:p.indices.length/3,textured:!!p.textureRef||!!p.texture})),
      instanceVisible:!!scene.getInstancedMeshDataPieces(id), sibling:[...scene.getInstancedMeshDataPieces(sibling)[0].positions],
      modelParts:m.geometryResult.meshes.filter(p=>p.expressId===id).map(p=>({item:p.geometryItemId,triangles:p.indices.length/3})),
      undo:s.undoStacks.get(m.id)?.length??0,redo:s.redoStacks.get(m.id)?.length??0 };
  });
  await panel.getByRole('button',{name:'Compare original',exact:true}).click();
  const original=await snapshot(); assert.equal(original.instanceVisible,true);assert.equal(original.flat,undefined);
  await panel.getByRole('button',{name:'Show preview',exact:true}).click();
  await panel.getByRole('button',{name:'Apply',exact:true}).click();
  await page.waitForFunction(()=>{const s=window.__evaluatedStore.getState();return (s.undoStacks.get([...s.models.keys()][0])?.length??0)===1;},undefined,{timeout:60000});
  const applied=await snapshot();assert.equal(applied.instanceVisible,false);assert.equal(applied.flat.length,1);assert.equal(applied.flat[0].textured,true);assert.equal(applied.modelParts.length,1);
  await page.screenshot({path:path.join(out,'applied.png')});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  const undone=await snapshot();assert.equal(undone.instanceVisible,true);assert.equal(undone.flat,undefined);assert.equal(undone.modelParts.length,0);
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  const redone=await snapshot();assert.deepEqual(redone,applied);
  assert.deepEqual(applied.sibling,original.sibling);assert.deepEqual(undone.sibling,original.sibling);
  assert.equal(applied.selected,loaded.globalId);
  fs.writeFileSync(path.join(out,'journey.json'),JSON.stringify({original,applied,undone,redone},null,2));
  console.log('APPLY_UNDO_REDO_COMPLETE');
  await page.getByRole('tab',{name:'File',exact:true}).click();
  await page.getByRole('button',{name:'Export IFC (with changes)',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Export IFC File'});await dialog.waitFor();
  fs.writeFileSync(path.join(out,'export-dialog.txt'),await dialog.innerText());
  const downloading=page.waitForEvent('download');
  await dialog.getByRole('button',{name:'Export',exact:true}).click();
  const download=await downloading;assert.match(download.suggestedFilename(),/\.ifczip$/);
  const exported=path.join(out,download.suggestedFilename());await download.saveAs(exported);
  fs.writeFileSync(path.join(out,'export-path.txt'),exported);
  console.log('IFCZIP_EXPORTED',exported);
} finally {fs.writeFileSync(path.join(out,'last.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(out,'last.png')}).catch(error=>console.error(error));await browser.close();}
