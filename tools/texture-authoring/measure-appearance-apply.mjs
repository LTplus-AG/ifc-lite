// Manual real-browser acceptance; requires a running viewer and downloaded public fixtures.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
const out=process.env.APPLY_OUT ?? '/tmp/appearance-apply-measurement';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});page.setDefaultTimeout(20000);
page.on('console',m=>fs.appendFileSync(out+'/console.log',m.text()+'\n'));
const state=()=>page.evaluate(async()=>{const {useViewerStore}=await import('/src/store/index.ts');const s=useViewerStore.getState();return {selected:s.selectedEntity,models:[...s.models.values()].map(m=>{let hash=2166136261;const meshes=m.geometryResult?.meshes??[];for(const mesh of meshes)for(const a of [mesh.positions,mesh.normals,mesh.indices,mesh.uvs])if(a)for(const n of new Uint8Array(a.buffer,a.byteOffset,a.byteLength))hash=Math.imul(hash^n,16777619);const canonicalParts=meshes.map(mesh=>{let h=2166136261;for(const a of [mesh.positions,mesh.normals,mesh.indices,mesh.uvs])if(a)for(const n of new Uint8Array(a.buffer,a.byteOffset,a.byteLength))h=Math.imul(h^n,16777619);return [mesh.expressId,mesh.geometryItemId,h>>>0].join(':');}).sort();return {id:m.id,name:m.name,meshes:meshes.length,hash:hash>>>0,canonicalParts,textured:meshes.filter(x=>x.texture||x.textureRef).length};})};});
const ready=()=>page.waitForFunction(()=>{const p=document.querySelector('[aria-label="Appearance workspace"]');return p?.getAttribute('aria-busy')==='false'&&/Preview ready|failed|invalid|cannot/i.test(p.innerText)},{},{timeout:120000});
try{
await page.goto(process.env.APPLY_URL ?? 'http://127.0.0.1:5173/');
await page.evaluate(async()=>{window.__applyStore=(await import('/src/store/index.ts')).useViewerStore;});
await page.locator('#file-input-open').setInputFiles([process.env.APPLY_IFC ?? '/tmp/ifclite-public-captures/convento.ifczip',process.env.APPLY_OTHER_IFC ?? '/tmp/ifclite-public-captures/untextured-wall.ifc']);
await page.waitForFunction(()=>{const s=window.__applyStore.getState();return s.models.size===2&&[...s.models.values()].every(m=>m.geometryResult?.meshes.length)&&!s.isLoading;},undefined,{timeout:120000});console.log('LOADED',JSON.stringify(await state()));
await page.getByRole('tab',{name:'Author',exact:true}).click();await page.getByRole('button',{name:'Appearance',exact:true}).click();
const panel=page.getByLabel('Appearance workspace');await panel.waitFor({state:'visible'});await page.getByLabel('Appearance model').waitFor({state:'visible'});
const options=await page.getByLabel('Appearance model').locator('option').evaluateAll(xs=>xs.map(x=>({id:x.value,name:x.textContent})));console.log('MODELS',options);
const target=options.find(x=>/convento/i.test(x.name));if(!target||options.length!==2)throw Error('Expected two selectable models');
await page.getByLabel('Appearance model').selectOption(target.id);
await page.getByLabel('Appearance scope').selectOption('model');
await page.getByLabel('Upload appearance source').setInputFiles(process.env.APPLY_IMAGE ?? '/tmp/ifclite-public-captures/original/boulder_01_diff_1k.jpg');
await page.getByLabel('Texture mapping').selectOption('planar');await page.getByLabel('Projection plane').selectOption('xz');await ready();
const before=await state();console.log('PREVIEW',await panel.innerText(),JSON.stringify(before));await page.screenshot({path:out+'/federated-preview.png'});
const cdp=await page.context().newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');
await page.evaluate(()=>{const data={gaps:[],longTasks:[],heap:[],inputs:[],start:null,done:null};window.__appearanceTiming=data;let last=performance.now();const frame=t=>{data.gaps.push({at:t,gap:t-last});data.heap.push({at:t,used:performance.memory?.usedJSHeapSize,total:performance.memory?.totalJSHeapSize,limit:performance.memory?.jsHeapSizeLimit});last=t;if(data.done===null||t<data.done+200)requestAnimationFrame(frame);};requestAnimationFrame(frame);new PerformanceObserver(list=>{for(const e of list.getEntries())data.longTasks.push({at:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:false});document.addEventListener('wheel',e=>data.inputs.push({at:performance.now(),trusted:e.isTrusted,deltaY:e.deltaY}),{capture:true,passive:true});document.addEventListener('click',e=>{if(e.target.closest('button')?.textContent.trim()==='Apply'){data.start=performance.now();console.log('APPLY_MEASUREMENT_START');}},{capture:true});const observer=new MutationObserver(()=>{if(data.start!==null&&document.querySelector('[aria-label="Appearance workspace"]')?.textContent.includes('Appearance applied')){data.done=performance.now();observer.disconnect();}});observer.observe(document.body,{subtree:true,childList:true,characterData:true});});
await page.waitForTimeout(1000);
await page.mouse.move(800,550);
const started=new Promise(resolve=>page.on('console',m=>{if(m.text()==='APPLY_MEASUREMENT_START')resolve();}));
const clicking=page.getByRole('button',{name:'Apply',exact:true}).click();
await started;await new Promise(resolve=>setTimeout(resolve,100));
const inputRequested=Date.now();await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:800,y:550,deltaX:0,deltaY:120});const inputAcknowledged=Date.now();await clicking;
console.log('INPUT_ROUNDTRIP',inputAcknowledged-inputRequested);
await page.waitForFunction(()=>document.querySelector('[aria-label="Appearance workspace"]')?.textContent.includes('Appearance applied'),{},{timeout:120000});
await page.waitForTimeout(250);
// The post-commit scope refresh can replace the success notice; timing observer pins first successful publication.
const timing=await page.evaluate(()=>window.__appearanceTiming);timing.inputRoundtripMs=inputAcknowledged-inputRequested;timing.afterApplyHeap=await cdp.send('Runtime.getHeapUsage');await cdp.send('HeapProfiler.collectGarbage');timing.afterGcHeap=await cdp.send('Runtime.getHeapUsage');fs.writeFileSync(out+'/timing.json',JSON.stringify(timing,null,2));console.log('TIMING_COMPLETE',timing.done-timing.start);
const applied=await state();
for(const snap of [applied]){const other=snap.models.find(x=>x.id!==target.id),initial=before.models.find(x=>x.id===other.id);if(JSON.stringify(other)!==JSON.stringify(initial))throw Error('Non-target model changed');}
await page.getByRole('tab',{name:'Author',exact:true}).click();
await page.getByRole('button',{name:'Undo',exact:true}).click();
const undone=await state();
await page.getByRole('button',{name:'Redo',exact:true}).click();
const redone=await state();
for(const model of before.models){const restored=undone.models.find(m=>m.id===model.id);if(JSON.stringify(model.canonicalParts)!==JSON.stringify(restored.canonicalParts))throw Error('Undo canonical mesh identity mismatch');}
fs.writeFileSync(out+'/identity.json',JSON.stringify({before,applied,undone,redone},null,2));
if(JSON.stringify(applied.models)!==JSON.stringify(redone.models))throw Error('Redo geometry identity mismatch');
await page.screenshot({path:out+'/applied-redone.png'});
console.log('APPLY_UNDO_REDO_COMPLETE');
}finally{await page.screenshot({path:out+'/last.png'}).catch(e=>console.error(e));await browser.close();}
