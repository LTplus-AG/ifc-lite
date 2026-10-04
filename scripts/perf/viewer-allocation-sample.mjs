/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import {chromium} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {ViewerBenchmarkPage} from '../../tests/benchmark/viewer-benchmark-page.js';
import {guardViewerCompletion} from '../../tests/benchmark/metadata-render-readiness.js';
import {captureIdentity} from './interleaved-identity.mjs';
import {boundedDiagnostic,refusedRendererSnapshot,writeAtomicEvidence} from './interleaved-diagnostics.js';
import {GRAPHICS_PROFILE,LIMITS} from './interleaved-plan.mjs';
import {SUBJECTS,FIXTURE} from './viewer-allocation-plan.mjs';
import {installSourceSliceObserver,freezeResidentSource,classifySourceSlices} from './viewer-source-slice-observer.mjs';
import {ownedChrome} from './viewer-allocation-chrome.mjs';
import {INPUT_PROTOCOL,INPUT_SUBJECTS,registerInputWitness,captureInputWitness,disposeInputWitness} from './input-witness-integration.mjs';
const [configPath,output]=process.argv.slice(2),config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.inputProtocol!==null&&config.inputProtocol!==undefined&&config.inputProtocol!==INPUT_PROTOCOL)throw new Error('Unknown independent input protocol');
const subjects=config.inputProtocol?INPUT_SUBJECTS:SUBJECTS;
if(!Object.hasOwn(subjects,config.arm)||config.revision!==subjects[config.arm]||config.fixture?.sha256!==FIXTURE.sha256||config.fixture?.size!==FIXTURE.size)
  throw new Error('Fixed allocation subject/fixture mismatch');
const row={arm:config.arm,revision:config.revision,inputProtocol:config.inputProtocol??null,inputProof:config.inputProof,status:'started',events:[],wasmResponses:[],scope:'Instrumented allocation only; no normal timing or physical-memory verdict'};
let browser,page,phase='setup',eventBytes=0,inputRegistered=false;
const event=item=>{
  if(row.eventRefusal)return;
  const value={...item,phase,observerUTC:new Date().toISOString()},bytes=Buffer.byteLength(JSON.stringify(value));
  if(row.events.length>=10000||eventBytes+bytes>16*1024**2){row.eventRefusal='Event cap; tail uncertified';return;}
  row.events.push(value);eventBytes+=bytes;
};
const requireObserved=async(operation,ms)=>{const receipt=await boundedDiagnostic(operation,ms);if(receipt.status!=='observed')throw new Error(receipt.reason);return receipt.value;};
const checkErrors=()=>{
  if(row.eventRefusal||row.events.some(item=>item.kind==='pageerror'||item.kind==='crash'))throw new Error('Page/event failure');
  guardViewerCompletion(row.events.filter(item=>item.kind==='console').map(item=>item.text),()=>undefined,error=>{throw error;});
};
try {
  browser=await chromium.launch({channel:'chrome',headless:true,args:[...GRAPHICS_PROFILE.flags],timeout:30000});
  row.chrome=await requireObserved(ownedChrome(GRAPHICS_PROFILE.flags),5000);
  if(row.chrome.sha256!==config.chromeExecutableSha256)throw new Error('Actual Chrome hash differs from provenance');
  row.chrome.version=browser.version();const cdp=await browser.newBrowserCDPSession();
  row.systemInfo=await requireObserved(cdp.send('SystemInfo.getInfo'),5000);await cdp.detach();
  const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});page=await context.newPage();
  page.on('console',message=>event({kind:'console',level:message.type(),text:message.text()}));
  page.on('pageerror',error=>event({kind:'pageerror',text:String(error)}));page.on('crash',()=>event({kind:'crash'}));
  page.on('response',response=>{if(/\.wasm(?:[?#]|$)/.test(response.url()))row.wasmResponses.push({url:response.url(),status:response.status()});});
  await page.addInitScript(installSourceSliceObserver,{bytes:FIXTURE.size,fileName:FIXTURE.path.split('/').at(-1),deferMilestones:true});
  const benchmark=new ViewerBenchmarkPage(page,config.origin);await benchmark.setup();await benchmark.installSceneReadinessObserver();
  await page.evaluate(()=>globalThis.__ifc_lite_source_slice_observer__.armMilestones());
  if(config.inputProtocol){
    row.inputWitnessRegistration=await requireObserved(registerInputWitness(page,config.inputProof,config.arm,config.revision),2000);
    inputRegistered=true;
    row.instrumentation={inputReferenceBudget:256*1024**2,scope:'Same both arms: bounded synchronous delivery/native argument references; posttimer hashes. Retention/instrumentation overhead unmeasured; no normal timing claim'};
  }
  row.runtime=await page.evaluate(()=>({hardwareConcurrency:navigator.hardwareConcurrency,crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined'}));
  if(!row.runtime.crossOriginIsolated||!row.runtime.sharedArrayBuffer)throw new Error('Default isolated SAB runtime unavailable');
  phase='canonical-load';await benchmark.loadFile(config.fixture.file,false);await benchmark.waitForCompletion(600000,true);
  checkErrors();row.measuredMilestones=benchmark.getMetrics();
  row.readiness=await requireObserved(page.evaluate(refusedRendererSnapshot),2000);
  const logs=benchmark.getConsoleLogs().join('\n'),starts=[...logs.matchAll(/processParallel start, fileSizeMB=[\d.]+ workerCount=(\d+)/g)];
  const workerIds=[...new Set([...logs.matchAll(/\[stream\] worker\[(\d+)\]/g)].map(match=>Number(match[1])))].sort((a,b)=>a-b);
  const workerCount=starts.length===1?Number(starts[0][1]):0;
  if(workerCount<1||workerIds.length!==workerCount)throw new Error('Actual default pool census missing');
  Object.assign(row.runtime,{workerCount,workerIds});
  row.allocation=await requireObserved(page.evaluate(freezeResidentSource,FIXTURE.size),5000);
  row.attributedCopies=classifySourceSlices(row.allocation);row.status='allocation-observed';
  writeAtomicEvidence(output,JSON.stringify(row,null,2));
  phase='post-allocation-identity';
  const identity=await boundedDiagnostic(config.inputProtocol?captureInputWitness(page,LIMITS):page.evaluate(captureIdentity,LIMITS),LIMITS.identityMs);
  row.fullAppearanceIdentity=identity; // Unsupported authored channels remain an explicit refusal; allocation witness survives.
  if(identity.status==='observed'&&identity.value?.complete!==true)row.fullAppearanceIdentity={status:'unavailable',reason:'Full identity incomplete',raw:identity.value};
  if(config.inputProtocol&&(row.fullAppearanceIdentity.status!=='observed'||row.fullAppearanceIdentity.value?.complete!==true))throw new Error('Independent input/retained appearance identity refused');
  checkErrors();
  if(!row.wasmResponses.some(response=>response.status===200&&new URL(response.url).origin===config.origin
    && config.defaultWasmPaths.includes(new URL(response.url).pathname))||row.wasmResponses.some(response=>response.status!==200||new URL(response.url).origin!==config.origin))throw new Error('Default source-built WASM response absent/foreign/failed');
} catch(error){row.status='refused';row.reason=String(error);process.exitCode=1;}
finally {
  try {
    if(page){
      if(!row.allocation){row.partialSliceWitness=await boundedDiagnostic(page.evaluate(()=>globalThis.__ifc_lite_source_slice_observer__?.freeze()),2000);}
      row.finalSnapshot=await boundedDiagnostic(page.evaluate(refusedRendererSnapshot),2000);
      row.screenshot=await boundedDiagnostic(page.screenshot({path:`${output}.png`,timeout:3000}),3000);
      if(row.screenshot.status!=='observed'||row.screenshot.value.byteLength>16*1024**2){
        row.screenshot={status:'unavailable',reason:'Pre-teardown screenshot unavailable/over cap'};
        row.status='refused';row.reason??=row.screenshot.reason;process.exitCode=1;
      } else row.screenshot={status:'observed',bytes:row.screenshot.value.byteLength,path:`${output}.png`};
    }
    if(row.status==='allocation-observed')checkErrors();
    row.preTeardownUTC=new Date().toISOString();writeAtomicEvidence(output,JSON.stringify(row,null,2));
  } catch(error){row.finalEvidenceFailure=String(error);row.status='refused';row.reason??=row.finalEvidenceFailure;process.exitCode=1;}
  finally {
    if(inputRegistered&&page){
      row.inputWitnessCleanup=await boundedDiagnostic(disposeInputWitness(page),2000);
      if(row.inputWitnessCleanup.status==='observed')row.inputWitnessCleanup=row.inputWitnessCleanup.value;
      if(row.inputWitnessCleanup?.restored!==true){row.status='refused';row.reason??='Input witness cleanup/refusal';process.exitCode=1;}
    }
    // Disposal is still before intentional teardown: late load faults remain fatal.
    if(row.status==='allocation-observed')try{checkErrors();}catch(error){row.status='refused';row.reason=String(error);process.exitCode=1;}
    phase='teardown';console.log('[allocation-phase] teardown');
    row.teardown=browser?(await boundedDiagnostic(browser.close(),30000)).status==='observed'?'complete':'refused':'complete';
    if(row.teardown!=='complete'){row.status='refused';process.exitCode=1;}
    try {writeAtomicEvidence(output,JSON.stringify(row,null,2));}catch(error){console.error('Final allocation receipt failed:',error);process.exitCode=1;}
  }
}
