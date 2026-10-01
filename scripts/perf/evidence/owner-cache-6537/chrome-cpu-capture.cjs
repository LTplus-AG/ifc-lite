/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const fs = require('node:fs');
const cp = require('node:child_process');
const { chromium } = require('/home/louistrue/wt/6537-foreground-base-session6503/node_modules/@playwright/test');
const ROOT = '/tmp/6232-takeover/6537-chrome-cpu-controls-v2';
fs.mkdirSync(ROOT, { recursive: true });
const names = { ac20: 'AC20-FZK-Haus.ifc', holter: 'ISSUE_053_20181220Holter_Tower_10.ifc', os1: 'O-S1-BWK-BIM architectural - BIM bouwkundig.ifc' };
const source = {base:'3e2779997ae165c36f6939419f9229debc73c163', branch:'ffa087d031df2f48d57fd216aa8d00b783dfd8c4'};
const schedule = [];
for (let i=0;i<5;i++) for (const side of i%2 ? ['A2','A1'] : ['A1','A2']) schedule.push({control:'AA',fixture:'ac20',pair:i,side,build:'base'});
for (const fixture of ['ac20','holter','os1']) for (let i=0;i<5;i++) for (const build of i%2 ? ['branch','base'] : ['base','branch']) schedule.push({control:'AB',fixture,pair:i,side:build,build});
function bounded(p, label, ms=15000) { let timer; return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms)})]).finally(()=>clearTimeout(timer)); }
async function sample(item, index) {
 const row = {...item,index,capturedAt:new Date().toISOString(),source:source[item.build],scope:'Canonical viewer first-file CPU worker-stream completion and metadata publication; NOT GPU frame readiness or full-lifetime/cache performance.',hostBefore:cp.execFileSync('cat',['/proc/loadavg'],{encoding:'utf8'}).trim()};
 let browser;
 try {
  browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']});
  row.chrome = browser.version();
  const context=await bounded(browser.newContext({viewport:{width:1280,height:800}}),'newContext');
  const page=await bounded(context.newPage(),'newPage');
  await page.goto('http://127.0.0.1:'+(item.build==='base'?5327:5328)+'/',{timeout:30000});
  await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__&&[...document.querySelectorAll('input[type=file]')].some(e=>e.accept.startsWith('.ifc')),null,{timeout:30000});
  row.environment=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter(); return {hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated,visibility:document.visibilityState,focused:document.hasFocus(),adapter:a?{vendor:a.info.vendor,architecture:a.info.architecture,fallback:a.info.isFallbackAdapter}:null};});
  row.fixtureInfo=await page.evaluate(async ({fixture,name})=>{
   const bytes=await(await fetch('/__fixture/'+fixture)).arrayBuffer();
   const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   const dt=new DataTransfer(); dt.items.add(new File([bytes],name));
   const input=[...document.querySelectorAll('input[type=file]')].find(e=>e.accept.startsWith('.ifc'));
   __perfCapture.startLoad=performance.now();
   __perfCapture.visibility=[];
   addEventListener('visibilitychange',()=>__perfCapture.visibility.push({t:performance.now(),state:document.visibilityState}));
   input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
   return {bytes:bytes.byteLength,sha256:sha,name};
  },{fixture:item.fixture,name:names[item.fixture]});
  await page.waitForFunction(()=>__perfCapture.logs.some(r=>r.text.startsWith('[useIfc] Stream complete'))&&__perfCapture.logs.some(r=>r.text.startsWith('[useIfc] Data model parsing complete')),null,{timeout:120000});
  row.observation=await page.evaluate(()=>{
   const state=__ifc_lite_viewer_store__.getState();
   let hash=2166136261;
   const add=arr=>{const bytes=arr instanceof Uint8Array?arr:new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength);for(let i=0;i<bytes.length;i++)hash=Math.imul(hash^bytes[i],16777619);};
   const meshes=[...(state.geometryResult?.meshes??[])].sort((a,b)=>a.expressId-b.expressId||Number(a.geometryItemId??0)-Number(b.geometryItemId??0));
   let vertices=0,triangles=0;
   for(const m of meshes){for(const key of ['positions','normals','indices'])if(m[key])add(m[key]);vertices+=(m.positions?.length??0)/3;triangles+=(m.indices?.length??0)/3;add(new TextEncoder().encode(JSON.stringify({expressId:m.expressId,geometryItemId:m.geometryItemId,color:m.color,origin:m.origin,localToWorld:m.localToWorld,geometryHash:m.geometryHash,appearanceSource:m.appearanceSource},(_,v)=>typeof v==='bigint'?v.toString():v)));}
   const stream=__perfCapture.logs.find(r=>r.text.startsWith('[useIfc] Stream complete'));
   const metadata=__perfCapture.logs.find(r=>r.text.startsWith('[useIfc] Data model parsing complete'));
   const start=__perfCapture.logs.find(r=>r.text.startsWith('[stream] processParallel start'));
   const afterInput=r=>r.t-__perfCapture.startLoad;
   return {streamAfterInputMs:afterInput(stream),metadataAfterInputMs:afterInput(metadata),workerStreamWallMs:stream.t-start.t,geometry:{meshes:meshes.length,retainedVertices:vertices,retainedTriangles:triangles,totalVertices:state.geometryResult?.totalVertices,totalTriangles:state.geometryResult?.totalTriangles,fullPositionsNormalsIndicesAppearanceFNV32:(hash>>>0).toString(16)},models:[...state.models.values()].map(m=>({name:m.name,loadState:m.loadState,geometryLoadState:m.geometryLoadState,metadataLoadState:m.metadataLoadState})),loading:state.loading,streaming:state.geometryStreamingActive,logs:__perfCapture.logs,errors:__perfCapture.errors,visibilityChanges:__perfCapture.visibility,observedAt:performance.now(),renderStats:globalThis.__ifc_lite_render_stats__?.()};
  });
  row.workerStreamValid = row.environment.crossOriginIsolated && row.environment.visibility==='visible' && row.observation.visibilityChanges.length===0 && row.observation.geometry.retainedVertices>0 && row.observation.geometry.retainedTriangles>0;
  row.renderReady=false;
 } catch(e){row.failure={message:e.message,stack:e.stack};row.workerStreamValid=false;}
 finally { if(browser) try{await bounded(browser.close(),'browserClose')}catch(e){row.teardownFailure=e.message;row.workerStreamValid=false;} }
 row.hostAfter=cp.execFileSync('cat',['/proc/loadavg'],{encoding:'utf8'}).trim();
 fs.writeFileSync(ROOT+'/'+String(index).padStart(2,'0')+'-'+item.control+'-'+item.fixture+'-'+item.side+'.json',JSON.stringify(row,null,2)+'\n');
 fs.appendFileSync(ROOT+'/runs.jsonl',JSON.stringify(row)+'\n');
 console.log(JSON.stringify({index,control:item.control,fixture:item.fixture,pair:item.pair,side:item.side,workerStreamValid:row.workerStreamValid,streamMs:row.observation?.streamAfterInputMs,workerStreamWallMs:row.observation?.workerStreamWallMs,metadataMs:row.observation?.metadataAfterInputMs,geometry:row.observation?.geometry,failure:row.failure?.message,teardownFailure:row.teardownFailure}));
 return row;
}
(async()=>{if(fs.existsSync(ROOT+'/runs.jsonl'))throw Error('Existing immutable output; select a new output directory before repeating');fs.writeFileSync(ROOT+'/schedule.json',JSON.stringify({schedule,source,scope:'CPU worker-stream control; software Chrome; 5 interleaved matched pairs; fresh browser process every sample; no full app/render readiness claim'},null,2)+'\n');for(let i=0;i<schedule.length;i++){const row=await sample(schedule[i],i);if(!row.workerStreamValid){console.error('Stopping after preserved invalid sample; no substitution');process.exitCode=1;break;}}})().catch(e=>{console.error(e);process.exitCode=1});
