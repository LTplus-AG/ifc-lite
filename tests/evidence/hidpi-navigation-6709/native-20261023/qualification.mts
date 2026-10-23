/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { geometryWitnessExpression } from './geometry-witness.mts';
import { fullQuality, requireDimensions } from './frame-dimensions.mts';
import { verifyFinalHealth } from './sample-health.mts';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchNativeChrome, readPhysicalSession, isPhysicalConsole, readHostAdmission } from './native-platform.mts';
const root = process.env.IFC_6709_ROOT;
if (!root) throw Error('IFC_6709_ROOT required');
const { startStaticServer } = await import(`${root}/scripts/perf/browser-static-server.ts`);
const { closeBrowserWithTimeout } = await import(`${root}/scripts/perf/browser-cold-teardown.ts`);
const { frameProbeInitScript } = await import(`${root}/tests/benchmark/frames/frame-probe.ts`);
const { orbitGesture } = await import(`${root}/tests/benchmark/frames/frame-scenarios.ts`);
const { realGpuFrameRows } = await import(`${root}/tests/benchmark/frames/frame-stats.ts`);
const { interleavedSchedule, summarizeSamples } = await import(`${root}/scripts/perf/frame-gpu-summary.ts`);
const { probeMetadataRenderTrace, waitForMetadataRenderReadiness } = await import(`${root}/tests/benchmark/metadata-render-readiness.ts`);
const { decodePng } = await import(`${root}/tests/e2e/federation-control-triplet.rendering.ts`);

const directory = process.env.IFC_6709_EVIDENCE;
if (!directory) throw Error('IFC_6709_EVIDENCE required');
const require = createRequire(`${root}/package.json`);
const { chromium } = require('@playwright/test');
const pairs = 5;
const smoke = process.argv.includes('--smoke');
const schedule = smoke ? [{pair:0,side:'branch',dpr:2}] : [1, 2].flatMap(dpr => interleavedSchedule(pairs, true).map(sample => ({ ...sample, dpr })));
if (process.argv.includes('--plan')) { console.log(JSON.stringify(schedule)); process.exit(0); }
const output = `${directory}/cohort-${new Date().toISOString().replaceAll(':', '-')}`;
mkdirSync(output);
const manifests = Object.fromEntries(['base', 'branch'].map(side => [side,
  JSON.parse(readFileSync(`${directory}/${side === 'base' ? 'base' : 'candidate'}-build-manifest.json`, 'utf8'))]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const manifest of Object.values(manifests)) {
  const git = (...args) => execFileSync('git', args, { cwd: manifest.checkout, encoding: 'utf8', timeout: 10000 }).trim();
  if (git('rev-parse', 'HEAD') !== manifest.head || git('status', '--porcelain')) throw Error('Source pin or cleanliness changed');
  for (const artifact of manifest.artifacts) {
    if (digest(readFileSync(`${manifest.buildRoot}/${artifact.path}`)) !== artifact.sha256) throw Error(`Pinned artifact changed: ${artifact.path}`);
  }
}
let current = manifests.base.buildRoot;
const model = process.env.IFC_6709_MODEL;
if (!model || digest(readFileSync(model)) !== 'd42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5') throw Error('Canonical public FZK fixture hash mismatch');
const server = await startStaticServer({ port: 0, host: '0.0.0.0', root: () => `${current}/apps/viewer/dist`, extra: new Map([['/__6709/model.ifc', model]]) });
const origin = `http://localhost:${server.address().port}`;
const observer = `(() => {
 const state = globalThis.__6709 = { presents:[], reads:[], downloads:[], errors:[], adapters:[] };
 addEventListener('error',event=>state.errors.push(String(event.error || event.message)));
 addEventListener('unhandledrejection',event=>state.errors.push(String(event.reason)));
 const requestDevice=GPUAdapter.prototype.requestDevice;
 GPUAdapter.prototype.requestDevice=async function(...args) {
  const info=this.info;state.adapters.push({vendor:info.vendor,architecture:info.architecture,fallback:info.isFallbackAdapter});
  const device=await requestDevice.apply(this,args);
  device.addEventListener('uncapturederror',event=>state.errors.push('GPU:'+event.error.message));
  device.lost.then(info=>{ if(info.reason!=='destroyed') state.errors.push('GPU lost:'+info.message); });
  return device;
 };
 const original = GPUCanvasContext.prototype.getCurrentTexture;
 GPUCanvasContext.prototype.getCurrentTexture = function() {
  const texture=original.call(this), canvas=this.canvas;
  if(canvas instanceof HTMLCanvasElement && canvas.dataset.viewport==='main') {
   const rect=canvas.getBoundingClientRect();
   state.presents.push({ts:performance.now(),width:texture.width,height:texture.height,cssWidth:rect.width,cssHeight:rect.height,dpr:devicePixelRatio,viewProjection:globalThis.__ifc_lite_view_projection__?.() ?? null});
  }
  return texture;
 };
 const dataURL=HTMLCanvasElement.prototype.toDataURL;
 HTMLCanvasElement.prototype.toDataURL=function(...args) {
  const value=dataURL.apply(this,args);
  if(this.dataset.viewport==='main') state.reads.push({width:this.width,height:this.height,ts:performance.now()});
  return value;
 };
 const click=HTMLAnchorElement.prototype.click;
 HTMLAnchorElement.prototype.click=function() {
  if(this.download.endsWith('.png') && this.href.startsWith('data:image/png')) state.downloads.push({filename:this.download,href:this.href});
  else click.call(this);
 };
})()`;
const take = page => page.evaluate('globalThis.__ifc_lite_frame_probe__.take()');
const dimensions = async page => {
  const value = await page.evaluate(`(() => { const c=document.querySelector('canvas[data-viewport="main"]'),r=c.getBoundingClientRect(); return {width:c.width,height:c.height,cssWidth:r.width,cssHeight:r.height,dpr:devicePixelRatio}; })()`);
  requireDimensions(value);
  return value;
};
async function idle(page) {
  const deadline = Date.now() + 15000;
  let count = 0;
  const collected = [];
  while (count < 12) {
    if (Date.now() >= deadline) throw Error('Viewer did not reach idle');
    await sleep(100);
    const frames = await take(page);
    collected.push(...frames);
    for (const frame of frames) count = frame.presents ? 0 : count + 1;
  }
  return collected;
}
async function geometry(page) {
  return page.evaluate(geometryWitnessExpression());
}

const records = [];
let activeRecord=null,rejectActiveDriver=null;
const originalStderr=process.stderr.write.bind(process.stderr);
const gpuDriverFailure=/ERROR:gpu\/|GL_INVALID_|uninitialized SharedImage|GPU process.*crash/i;
process.stderr.write=function(chunk,...args){
 const line=String(chunk);
 if(activeRecord && gpuDriverFailure.test(line)){
  activeRecord.meta.gpuDriverErrors.push(line.trim());
  rejectActiveDriver?.(Error('Native GPU driver error; refuse sample'));
 }
 return originalStderr(chunk,...args);
};
const cohortStarted = Date.now();
try {
 for (const sample of schedule) {
  if (Date.now() >= Number(process.env.IFC_6709_DEADLINE)) { console.error('Admitted cohort deadline reached'); break; }
  if(Date.now()-cohortStarted>27*60*1000) { console.error('Cohort start budget exhausted; no further sample launched');break; }
  const name = `dpr${sample.dpr}-${sample.side}-p${sample.pair}`;
  console.log(name);
  const record = { ...sample, ok:false, rows:[], meta:{gpuDriverErrors:[]} };
  activeRecord=record;
  const driverFailure=new Promise((_,reject)=>{rejectActiveDriver=reject;});
  void driverFailure.catch(error=>{record.meta.driverRejection=String(error);});
  let browser, sampleTimer, page;
  try {
   record.meta.hostBefore=await readHostAdmission();
   if(!record.meta.hostBefore.quiet) throw Error('Host pre-admission refused');
   record.meta.sessionBefore=readPhysicalSession();
   if(!isPhysicalConsole(record.meta.sessionBefore)) throw Error('Physical-console admission refused');
   current=manifests[sample.side].buildRoot;
   browser=await launchNativeChrome(chromium);
   const deadline=new Promise((_,reject)=>{sampleTimer=setTimeout(()=>reject(Error('Native sample exceeded four-minute deadline')),240000);});
   await Promise.race([(async()=>{
   const context=await browser.newContext({ viewport:{width:1440,height:900},deviceScaleFactor:sample.dpr });page=await context.newPage();
   const logs=[];record.meta.console=logs;page.on('console',message=>logs.push(message.text()));
   page.setDefaultTimeout(30000);
   const cdp=await context.newCDPSession(page);
   await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:sample.dpr,mobile:false});
   await context.addInitScript({content:frameProbeInitScript({workDone:true})});
   await context.addInitScript({content:observer});
   await page.goto(`${origin}/?perfTrace=1`,{timeout:30000});
   await page.getByRole('button',{name:'Collapse sidebar to icons',exact:true}).click();
   await page.waitForFunction('globalThis.__ifc_lite_viewer_store__.getState().sidebarMode==="collapsed"');
   record.meta.layout='Normal UI: sidebar collapsed before first model load; location map unmounted';
   await page.locator('#file-input-open').waitFor({state:'attached'});
   await page.locator('#file-input-open').setInputFiles(model);
   await page.bringToFront();
   await waitForMetadataRenderReadiness({trace:async()=>{const value=await probeMetadataRenderTrace(page);record.meta.latestReadinessTrace=value;return value;},logs:()=>logs,
    canvasReady:()=>page.evaluate(`(() => {const c=document.querySelector('canvas[data-viewport="main"]');return !!c && c.width>0 && c.height>0 && globalThis.__ifc_lite_render_stats__?.().frame?.drawCalls>0;})()`),
    now:()=>performance.now(),pause:()=>sleep(50),timeoutMs:90000});
   record.meta.loadTrace=await probeMetadataRenderTrace(page);
   if(!record.meta.loadTrace?.ended || record.meta.loadTrace.failed.length) throw Error('Complete authoritative load trace missing or failed');
   record.meta.adapter=await page.evaluate('globalThis.__ifc_lite_render_stats__().adapter');
   record.meta.requestedAdapters=await page.evaluate('globalThis.__6709.adapters');
   if(!record.meta.requestedAdapters.length || record.meta.requestedAdapters.some(info=>info.vendor!=='nvidia' || info.fallback))throw Error('Actual device request did not use non-fallback NVIDIA hardware');
   if(!record.meta.adapter?.vendor || (record.meta.adapter.isFallbackAdapter || record.meta.adapter.fallback) || /swiftshader|software|llvmpipe/i.test(JSON.stringify(record.meta.adapter))) throw Error('Actual viewer hardware adapter missing or software');
   const observedDpr=await page.evaluate('devicePixelRatio');
   if(Math.abs(observedDpr-sample.dpr)>0.00001) throw Error('Requested DPR not observed');
   await idle(page);
   await page.keyboard.press('Home');
   await idle(page);
   record.meta.geometryBefore=await geometry(page);
   record.meta.settledBefore=await dimensions(page);
   fullQuality(record.meta.settledBefore,sample.dpr);
   await page.screenshot({path:`${output}/${name}-home.png`});
   const rect=await page.locator('canvas[data-viewport="main"]').boundingBox();
   if(!rect) throw Error('Main viewport missing');
   await page.evaluate('globalThis.__ifc_lite_frame_probe__.beginForegroundGuard()');
   await take(page);
   await page.evaluate('globalThis.__6709.presents=[]');
   const start=performance.now();
   const steps=orbitGesture(rect,240);
   for(let i=0;i<steps.length;i++) {
    const remaining=start+i*8.333333333-performance.now();
    if(remaining>0) await sleep(remaining);
    for(const input of steps[i]) await cdp.send(input.method,input.params);
   }
   const frames=await idle(page);
   record.rows=realGpuFrameRows(`FZK-DPR${sample.dpr}`,'orbit',frames);
   if (record.rows.length === 0 || record.rows.some(row => !Number.isFinite(row.value))) throw Error('Native timing metrics missing or nonfinite');
   writeFileSync(`${output}/${name}-frames.json`,JSON.stringify(frames));
   const presents=await page.evaluate('globalThis.__6709.presents');
   writeFileSync(`${output}/${name}-presents.json`,JSON.stringify(presents));
   if(presents.length<10 || frames.length<10) throw Error('Navigation has insufficient actual frame observations');
   for (const present of presents) requireDimensions(present);
   const ratios=presents.map(p=>p.width/p.cssWidth);
   record.meta.interactiveMinimumRatio=Math.min(...ratios);
   record.meta.distinctNavigationViews=new Set(presents.filter(p=>p.viewProjection).map(p=>JSON.stringify(p.viewProjection))).size;
   if(record.meta.distinctNavigationViews<2)throw Error('Driven gesture did not move the actual renderer camera');
   record.meta.transitions={first:presents[0],last:presents.at(-1),cssFrames:ratios.filter(r=>Math.abs(r-1)<0.01).length,fullFrames:ratios.filter(r=>Math.abs(r-sample.dpr)<0.01).length};
   fullQuality(presents.at(-1),sample.dpr);
   if(sample.side==='branch' && sample.dpr===2 && !ratios.some(r=>Math.abs(r-1)<0.01)) throw Error('Interactive frame never reached CSS resolution');
   if(sample.side==='base' && sample.dpr===2 && ratios.some(r=>r<1.9)) throw Error('Baseline unexpectedly changed resolution');
   record.meta.settledAfter=await dimensions(page);fullQuality(record.meta.settledAfter,sample.dpr);
   // Capture through the actual command palette while a real orbit drag is held.
   await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
   await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+60,rect.y+rect.height/2+20);
   await sleep(100);
   record.meta.captureRequestedDimensions=await dimensions(page);
   if(sample.side==='branch' && sample.dpr===2) fullQuality(record.meta.captureRequestedDimensions,1);
   await page.screenshot({path:`${output}/${name}-held-navigation.png`});
   await page.keyboard.press('Control+k');
   await page.getByRole('textbox',{name:'Search commands',exact:true}).fill('Screenshot');
   await page.getByRole('option',{name:/Screenshot/}).waitFor({state:'visible'});
   await page.keyboard.press('Enter'); // Preserve the held canvas drag; no synthetic mouse release on the palette option.
   await page.waitForFunction('globalThis.__6709.downloads.length===1');
   await page.mouse.move(rect.x+rect.width/2+80,rect.y+rect.height/2+30);await sleep(100);
   record.meta.interactiveAfterCapture=await dimensions(page);
   if(sample.side==='branch' && sample.dpr===2) fullQuality(record.meta.interactiveAfterCapture,1);
   await page.mouse.up();await idle(page);
   record.meta.settledAfterCapture=await dimensions(page);fullQuality(record.meta.settledAfterCapture,sample.dpr);
   const capture=await page.evaluate('globalThis.__6709.downloads[0]');
   const png=Buffer.from(capture.href.split(',')[1],'base64');
   record.meta.capture={filename:capture.filename,width:png.readUInt32BE(16),height:png.readUInt32BE(20),bytes:png.length,sha256:digest(png)};
   fullQuality({...record.meta.settledBefore,...record.meta.capture},sample.dpr);
   writeFileSync(`${output}/${name}-capture.png`,png);
   const pixels=decodePng(png), colors=new Set();let visiblePixels=0;
   for(let i=0;i<pixels.rgba.length;i+=4) if(pixels.rgba[i+3]>0){
    visiblePixels++;colors.add((pixels.rgba[i]<<16)|(pixels.rgba[i+1]<<8)|pixels.rgba[i+2]);
   }
   record.meta.capture.visiblePixels=visiblePixels;record.meta.capture.distinctVisibleColors=colors.size;
   if(visiblePixels<1000 || colors.size<16)throw Error('Exported PNG is empty or lacks rendered model detail; dimensions alone do not qualify capture');
   record.meta.geometryAfter=await geometry(page);
   if(JSON.stringify(record.meta.geometryBefore)!==JSON.stringify(record.meta.geometryAfter)) throw Error('Loaded geometry changed during navigation/capture');
   await page.keyboard.press('Home');await idle(page);
   // Fixed before measurement from the uncapped DPR1/2 diagnostic. No fallback
   // target search after a failed pick; preserve the known boundary discrepancy.
   const pickCases=[
    {id:27421,geometryItemId:27395,sourceTriangleIndex:10,expected:27421,scope:'opaque wall'},
    {id:59553,geometryItemId:59529,sourceTriangleIndex:2,expected:59553,scope:'roof slab'},
    {id:27421,geometryItemId:27395,sourceTriangleIndex:1,expected:28113,scope:'control-observed wall/window boundary; stability only'},
   ];
   record.meta.picks=[];
   for(const witness of pickCases){
    const target=await page.evaluate(witness=>{
     const hit=globalThis.__ifc_lite_scene_face_hits__(witness.id).find(h=>h.geometryItemId===witness.geometryItemId && h.sourceTriangleIndex===witness.sourceTriangleIndex);
     if(!hit)return null;
     const c=document.querySelector('canvas[data-viewport="main"]').getBoundingClientRect();
     if(hit.screen.x<=c.left+10 || hit.screen.x>=c.right-10 || hit.screen.y<=c.top+10 || hit.screen.y>=c.bottom-10)return null;
     return {...witness,x:hit.screen.x,y:hit.screen.y};
    },witness);
    if(!target)throw Error('Predeclared CSS pick face unavailable');
    await page.mouse.click(target.x,target.y);
    await page.waitForFunction('globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId=== '+target.expected);
    record.meta.picks.push(target);
   }
   record.meta.pick={id:record.meta.picks.map(p=>p.expected).join(',')};
   record.meta.foreground=await page.evaluate('globalThis.__ifc_lite_frame_probe__.foreground()');
   if(record.meta.foreground.interruptions || record.meta.foreground.visibility!=='visible' || !record.meta.foreground.focused) throw Error('Foreground admission interrupted');
   record.meta.sessionAfter=readPhysicalSession();
   if(!isPhysicalConsole(record.meta.sessionAfter) || record.meta.sessionBefore.currentSession!==record.meta.sessionAfter.currentSession) throw Error('Physical-console session changed');
   await verifyFinalHealth(record.meta,()=>idle(page),readHostAdmission,
    ()=>page.evaluate('globalThis.__6709.errors'));
   })(),deadline,driverFailure]);
   record.ok=true;
  } catch(error) { record.error=String(error);console.error(name,record.error);if(page && !page.isClosed()) { try {record.meta.failureDiagnostics=await page.evaluate('({trace:globalThis.__IFC_LITE_LOAD_TRACE__?.latest?.(),stats:globalThis.__ifc_lite_render_stats__?.(),canvas:!!document.querySelector("canvas[data-viewport=main]")})');await page.screenshot({path:`${output}/${name}-failure.png`,timeout:5000});} catch(screenshotError) {record.meta.screenshotError=String(screenshotError);} } }
  finally {
   clearTimeout(sampleTimer);
   if(browser?.isConnected()) {
    const failure=await closeBrowserWithTimeout(browser,15000);
    if(failure){record.ok=false;record.error=`${record.error||''} CDP disconnect: ${failure}`;}
   }
  }
  if(record.meta.gpuDriverErrors.length){record.ok=false;record.error=record.error||'Native GPU driver error observed';}
  activeRecord=null;rejectActiveDriver=null;
  records.push(record);appendFileSync(`${output}/runs.jsonl`,JSON.stringify(record)+'\n');
  if(!record.ok) break; // A refused/failed sample is retained; no replacement cohort.
 }
} finally { process.stderr.write=originalStderr;server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
const identities=new Set(records.filter(r=>r.ok).map(r=>JSON.stringify(r.meta.geometryBefore)));
const pickIds=new Set(records.filter(r=>r.ok).map(r=>r.meta.pick.id));
const completedSuccessfully=records.length===schedule.length && records.every(r=>r.ok) && identities.size===1 && pickIds.size===1;
const summary={performanceVerdict:'REQUIRES_REVIEW; functional completion is not a frame-rate verdict',smoke,planned:schedule.length,completed:records.length,geometryIdentityAcrossCohort:identities.size===1,pickIdentityAcrossCohort:pickIds.size===1,completedSuccessfully,allAccepted:!smoke && completedSuccessfully,rows:smoke?[]:summarizeSamples(records),scope:smoke?'One native functional smoke. No A/B or performance verdict.':'Source-pinned cap-only A/B with synchronous capture shared by both arms; exact commit identities are in the frozen manifests. Native evidence and all issue acceptance still require review before closure.'};
writeFileSync(`${output}/summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify({output,...summary}));
process.exit(completedSuccessfully?0:1);
