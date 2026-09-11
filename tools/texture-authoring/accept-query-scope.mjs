/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual real-model acceptance; run against an isolated local viewer session.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=process.env.EVALUATED_OUT ?? '/tmp/query-scopes-browser';fs.mkdirSync(out,{recursive:true});
const federated=process.env.EVALUATED_FEDERATED==='1';
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});page.setDefaultTimeout(30000);
page.on('console',message=>fs.appendFileSync(path.join(out,'console.log'),message.text()+'\n'));
page.on('pageerror',error=>fs.appendFileSync(path.join(out,'errors.log'),String(error)+'\n'));
try {
  await page.goto(process.env.EVALUATED_URL ?? 'http://127.0.0.1:4386/');
  await page.evaluate(async()=>{performance.setResourceTimingBufferSize(10000);window.__evaluatedStore=(await import('/src/store/index.ts')).useViewerStore;});
  const fixture=process.env.EVALUATED_IFC ?? path.resolve('tests/models/ara3d/AC20-FZK-Haus.ifc');
  await page.locator('#file-input-open').setInputFiles(federated?[fixture,'/tmp/evaluated-ui-federated-baseline/AC20-second.ifc']:fixture);
  await page.waitForFunction(count=>{const s=window.__evaluatedStore.getState();return s.models.size===count&&!s.isLoading&&[...s.models.values()].every(m=>m.ifcDataStore&&m.geometryResult);},federated?2:1,{timeout:120000});
  const loaded=await page.evaluate(async()=>{
    const moduleUrl=performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.includes('/src/hooks/useBCF.ts')).at(-1);
    const {getGlobalRenderer}=await import(moduleUrl ?? '/src/hooks/useBCF.ts');
    let renderer=getGlobalRenderer();
    for(let attempt=0;!renderer&&attempt<100;attempt++) { await new Promise(resolve=>setTimeout(resolve,100)); renderer=getGlobalRenderer(); }
    if(!renderer) throw new Error('Viewport renderer did not become available');
    window.__evaluatedRenderer=renderer;
    const s=window.__evaluatedStore.getState(),model=[...s.models.values()].at(-1),id=s.toGlobalId(model.id,35169);
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
  await page.evaluate(async()=>{
    const s=window.__evaluatedStore.getState(),m=[...s.models.values()].at(-1);
    const {saveFilter}=await import('/src/lib/search/saved-filters.ts');
    saveFilter('AC20 mapped member','AND',[{kind:'globalId',op:'in',values:[m.ifcDataStore.entities.getGlobalId(35169)]}]);
  });
  await page.getByRole('tab',{name:'Author',exact:true}).click();
  await page.getByRole('button',{name:'Appearance',exact:true}).click();
  const panel=page.getByLabel('Appearance workspace');await panel.waitFor();
  if(federated)await panel.getByLabel('Appearance model',{exact:true}).selectOption(loaded.modelId);
  await panel.getByLabel('Appearance scope',{exact:true}).selectOption('filter');
  await panel.locator('input[type=file]').first().setInputFiles(process.env.EVALUATED_IMAGE ?? '/tmp/ifclite-public-captures/derived/boulder-512.png');
  await page.waitForFunction(()=>/mapped occurrence|Only direct/.test(document.querySelector('[aria-label="Appearance workspace"]')?.textContent??''),undefined,{timeout:30000}).catch(async error=>{
    const text=await panel.innerText();if(!/support|representation|tessellat/i.test(text))throw error;
  });
  fs.writeFileSync(path.join(out,'preserve.txt'),await panel.innerText());
  await page.screenshot({path:path.join(out,'preserve.png')});
  await page.getByRole('checkbox',{name:/Convert supported objects to mesh/}).check();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance workspace"]')?.textContent.includes('Preview ready'),undefined,{timeout:120000});
  await page.screenshot({path:path.join(out,'preview.png')});
  fs.writeFileSync(path.join(out,'preview.txt'),await panel.innerText());
  console.log('PREVIEW_READY',JSON.stringify(loaded));
  const snapshot=()=>page.evaluate(()=>{
    const s=window.__evaluatedStore.getState(),m=[...s.models.values()].at(-1),scene=window.__evaluatedRenderer.getScene();
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
  await page.waitForFunction(()=>{const s=window.__evaluatedStore.getState();return (s.undoStacks.get([...s.models.keys()].at(-1))?.length??0)===1;},undefined,{timeout:60000});
  const applied=await snapshot();assert.equal(applied.instanceVisible,false);assert.equal(applied.flat.length,1);assert.equal(applied.flat[0].textured,true);assert.equal(applied.modelParts.length,1);
  await page.screenshot({path:path.join(out,'applied.png')});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  const undone=await snapshot();assert.equal(undone.instanceVisible,true);assert.equal(undone.flat,undefined);assert.equal(undone.modelParts.length,0);
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  const redone=await snapshot();assert.deepEqual(redone,applied);
  assert.deepEqual(applied.sibling,original.sibling);assert.deepEqual(undone.sibling,original.sibling);
  assert.equal(applied.selected,loaded.globalId);
  await panel.getByRole('button',{name:'Add this scope',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance assignments"]')?.textContent.includes('Scope reviewed'),undefined,{timeout:60000});
  const saving=page.waitForEvent('download');
  await panel.getByRole('button',{name:'Save recipe',exact:true}).click();
  const recipeDownload=await saving,recipePath=path.join(out,'query-recipe.json');await recipeDownload.saveAs(recipePath);
  const recipe=JSON.parse(fs.readFileSync(recipePath,'utf8'));
  assert.equal(recipe.assignments.length,1);assert.equal(recipe.assignments[0].query.kind,'filter');
  assert.deepEqual(recipe.assignments[0].members.map(member=>member.expressId),[35169]);
  await page.screenshot({path:path.join(out,'recipe-saved.png')});
  fs.writeFileSync(path.join(out,'journey.json'),JSON.stringify({loaded,original,applied,undone,redone,recipe},null,2));
  await page.reload();
  await page.evaluate(async()=>{performance.setResourceTimingBufferSize(10000);window.__evaluatedStore=(await import('/src/store/index.ts')).useViewerStore;});
  await page.locator('#file-input-open').setInputFiles(fixture);
  await page.waitForFunction(()=>{const s=window.__evaluatedStore.getState();return s.models.size===1&&!s.isLoading&&[...s.models.values()].every(m=>m.ifcDataStore&&m.geometryResult);},undefined,{timeout:120000});
  await page.getByRole('tab',{name:'Author',exact:true}).click();
  await page.getByRole('button',{name:'Appearance',exact:true}).click();
  await panel.locator('input[type=file]').first().setInputFiles(process.env.EVALUATED_IMAGE ?? '/tmp/ifclite-public-captures/derived/boulder-512.png');
  await panel.getByLabel('Restore assignment recipe').setInputFiles(recipePath);
  const restored=panel.getByLabel('Appearance assignments').first();
  await restored.getByText('Bind this saved scope to a loaded model and its original image.').waitFor();
  const binding=await page.evaluate(()=>{const s=window.__evaluatedStore.getState();return {model:[...s.models.keys()][0],source:s.appearanceSources[0].id};});
  await restored.locator('label').filter({hasText:'Loaded model'}).locator('select').selectOption(binding.model);
  await restored.locator('label').filter({hasText:'Original source'}).locator('select').selectOption(binding.source);
  await restored.getByRole('button',{name:'Review current scope',exact:true}).click();
  await restored.getByRole('region',{name:'Membership review'}).waitFor({timeout:60000});
  assert.match(await restored.innerText(),/0 added · 0 removed · 0 renumbered/);
  await restored.getByRole('button',{name:'Accept reviewed scope',exact:true}).click();
  await restored.getByRole('button',{name:'Preview all assignments',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance workspace"]')?.textContent.includes('Preview ready'),undefined,{timeout:120000});
  await panel.getByRole('button',{name:'Apply',exact:true}).click();
  await page.waitForFunction(()=>{const s=window.__evaluatedStore.getState();return (s.undoStacks.get([...s.models.keys()][0])?.length??0)===1;},undefined,{timeout:60000});
  const restoredGeometry=await page.evaluate(async()=>{
    const {getGlobalRenderer}=await import('/src/hooks/useBCF.ts');
    const renderer=getGlobalRenderer();if(!renderer)throw new Error('Restored renderer unavailable');
    const s=window.__evaluatedStore.getState(),m=[...s.models.values()][0],id=s.toGlobalId(m.id,35169);
    const parts=renderer.getScene().getMeshDataPieces(id)??[];
    const min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity};
    for(const part of parts)for(let i=0;i<part.positions.length;i+=3)for(const [axis,key] of ['x','y','z'].entries()){
      const v=part.positions[i+axis]+(part.origin?.[axis]??0);min[key]=Math.min(min[key],v);max[key]=Math.max(max[key],v);
    }
    if(parts.length){s.setSelectedEntityId(id);s.setSelectedEntity({modelId:m.id,expressId:35169});s.setIsolatedEntities(new Set([id]));renderer.getCamera().fitToBounds(min,max);renderer.requestRender();}
    return {modelId:m.id,productId:35169,parts:parts.map(part=>({itemId:part.geometryItemId,textured:!!part.textureRef||!!part.texture,triangles:part.indices.length/3})),
      instanceVisible:!!renderer.getScene().getInstancedMeshDataPieces(id),undo:s.undoStacks.get(m.id)?.length};
  });
  assert.equal(restoredGeometry.parts.length,1);assert.equal(restoredGeometry.parts[0].textured,true);
  assert.equal(restoredGeometry.instanceVisible,false);assert.equal(restoredGeometry.undo,1);
  fs.writeFileSync(path.join(out,'restored-geometry.json'),JSON.stringify(restoredGeometry,null,2));
  await page.waitForTimeout(250);
  fs.writeFileSync(path.join(out,'restored.txt'),await panel.innerText());
  await page.screenshot({path:path.join(out,'restored-applied.png')});
  console.log('QUERY_SCOPE_APPLY_UNDO_REDO_AND_FRESH_RECIPE_RESTORE_PASSED');
} finally {fs.writeFileSync(path.join(out,'last.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(out,'last.png')}).catch(error=>console.error(error));await browser.close();}
