/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Run from the repository root with the original authored PDF control IFCZIP.
import {chromium} from '@playwright/test';
import fs from 'node:fs';import assert from 'node:assert/strict';
const out=process.env.PROOF_OUT ?? '/tmp/annotation-fill-routing-browser';
const input=process.env.PROOF_IFCZIP;
const bootstrap=process.env.PROOF_BOOTSTRAP_IFCZIP;
if(!input || !bootstrap) throw new Error('Set PROOF_IFCZIP and PROOF_BOOTSTRAP_IFCZIP to the authored and base control files');
const baseUrl=process.env.PROOF_URL ?? 'http://127.0.0.1:4391/';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=default','--ignore-gpu-blocklist']});
let page=await browser.newPage({viewport:{width:1600,height:1200},acceptDownloads:true});page.setDefaultTimeout(45000);
async function bind(){await page.evaluate(async()=>{window.__pdfStore=(await import('/src/store/index.ts')).useViewerStore;const viewportModule=await (await fetch('/src/components/viewer/Viewport.tsx')).text();const hook=viewportModule.match(/from \"([^\"]*useBCF[^\"]*)\"/);for(const url of [...(hook?[hook[1]]:[]),...performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('/src/hooks/useBCF.')),'/src/hooks/useBCF.js','/src/hooks/useBCF.ts']){const r=(await import(url)).getGlobalRenderer();if(r){window.__pdfRenderer=r;break;}}});}
async function frame(){await page.evaluate(()=>{const r=window.__pdfRenderer,s=window.__pdfStore.getState();s.setIsolatedEntities(new Set([window.__pdfObject]));const parts=r.getScene().getMeshDataPieces(window.__pdfObject),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const p of parts)for(let i=0;i<p.positions.length;i+=3)for(let a=0;a<3;a++){const v=p.positions[i+a]+(p.origin?.[a]??0);min[a]=Math.min(min[a],v);max[a]=Math.max(max[a],v);}r.getCamera().setPresetView('front',{min:{x:min[0],y:min[1],z:min[2]},max:{x:max[0],y:max[1],z:max[2]}});r.requestRender();});await page.waitForTimeout(700);}
async function pick(){const points=await page.evaluate(()=>{const r=window.__pdfRenderer,rect=r.getCanvas().getBoundingClientRect();return r.getScene().getMeshDataPieces(window.__pdfObject).map(p=>{const v=[0,0,0];for(let c=0;c<3;c++)for(let a=0;a<3;a++)v[a]+=(p.positions[p.indices[c]*3+a]+(p.origin?.[a]??0))/3;const q=r.getCamera().projectToScreen({x:v[0],y:v[1],z:v[2]},rect.width,rect.height);return{x:rect.x+q.x,y:rect.y+q.y};});});for(const p of points){await page.mouse.click(p.x,p.y);await page.waitForTimeout(150);if(await page.evaluate(()=>window.__pdfStore.getState().selectedEntityId===window.__pdfObject))return p;}throw new Error('Normal pointer did not select PDF annotation');}
try{
 await page.goto(baseUrl);await bind();await page.locator('#file-input-open').setInputFiles(bootstrap);await page.waitForFunction(()=>{const s=window.__pdfStore?.getState();return s?.models.size===1&&[...s.models.values()][0].loadState==='complete';});for(let attempt=0;attempt<60;attempt++){await bind();if(await page.evaluate(()=>Boolean(window.__pdfRenderer)))break;await page.waitForTimeout(500);}await page.waitForFunction(()=>Boolean(window.__pdfRenderer));await page.evaluate(()=>{const r=window.__pdfRenderer;window.__fillUploads=[];const proto=Object.getPrototypeOf(r),original=proto.uploadAnnotationFills3D;proto.uploadAnnotationFills3D=function(fills){window.__fillUploads.push(fills.length);return original.call(this,fills);};});await page.locator('#file-input-open').setInputFiles(input);
 await page.waitForFunction(()=>{const s=window.__pdfStore?.getState();return s?.models.size===1&&[...s.models.values()][0].loadState==='complete';});await bind();
 const proof={created:{expressId:Number(process.env.PROOF_OWNER ?? 92)}};
 await page.evaluate(id=>{const s=window.__pdfStore.getState(),m=[...s.models.values()][0];window.__pdfObject=s.toGlobalId(m.id,id);s.clearEntitySelection();},proof.created.expressId);
 await frame();
 await page.waitForFunction(async()=>{const m=[...window.__pdfStore.getState().models.values()][0];const c=(await import('/src/hooks/symbolic-parse-cache.ts')).getParseFor(m.ifcDataStore);return c&&[...c.byStorey.values()].reduce((n,b)=>n+b.fills.length, c.looseFills.length)>=2;});
 await page.waitForTimeout(500);
 const result=await page.evaluate(async()=>{const s=window.__pdfStore.getState(),m=[...s.models.values()][0],c=(await import('/src/hooks/symbolic-parse-cache.ts')).getParseFor(m.ifcDataStore);return {overlayHasGeometry:window.__pdfRenderer.overlays.symbolic.fillPipeline.hasGeometry(),uploads:window.__fillUploads,drawings:[...c.byStorey.values()].flatMap(b=>b.fills).concat(c.looseFills).map(f=>({owner:f.ownerId,item:f.geometryItemId})),meshes:m.geometryResult.meshes.filter(p=>p.expressId===window.__pdfObject).map(p=>({owner:p.expressId,item:p.geometryItemId,triangles:p.indices.length/3}))};});
 assert.equal(result.drawings.length,2);assert.equal(result.meshes.length,2);assert.equal(result.overlayHasGeometry,false);assert.ok(result.uploads.every(n=>n===0));
 await page.screenshot({path:out+'/reopened-colours.png'});
 result.pick=await pick();await page.screenshot({path:out+'/reopened-selected.png'});fs.writeFileSync(out+'/proof.json',JSON.stringify(result,null,2));

 console.log('Normal import retains 2D fills, uploads no duplicate 3D fills, and remains pickable');
}catch(error){fs.writeFileSync(out+'/failure.txt',await page.locator('body').innerText());await page.screenshot({path:out+'/failure.png'});throw error;}finally{await browser.close();}
