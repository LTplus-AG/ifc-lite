/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,createWriteStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {SUBJECTS,FIXTURE,allocationVerdict,canSignalGroup,backendErrors} from './viewer-allocation-plan.mjs';
import {GRAPHICS_PROFILE} from './interleaved-plan.mjs';
import {inventory,fileHash} from './interleaved-assets.mjs';
import {serveFrozen} from './interleaved-server.mjs';
import {processIdentity,finishLog,stopWitnessedProcesses} from './interleaved-cleanup.mjs';
import {inputProtocol,INPUT_SUBJECTS,qualifyInputSubjects,requireInputAppearancePair} from './input-witness-integration.mjs';
const protocol=inputProtocol(process.env.INDEPENDENT_INPUT_DIAGNOSTIC);
const subjects=protocol?INPUT_SUBJECTS:SUBJECTS;
const root=resolve(import.meta.dirname,'../..'),output=join(root,'viewer-allocation-results');
const provenance=JSON.parse(readFileSync(join(output,'provenance.json'),'utf8')),rows=[],servers={};
let activeAbort,interrupted;
const handlers=['SIGINT','SIGTERM'].map(signal=>[signal,()=>{interrupted=signal;activeAbort?.(`Interrupted by ${signal}`);}]);
for(const [signal,handler]of handlers)process.on(signal,handler);
const report={status:'started',protocol,plannedControls:2,retries:0,rows,scope:'Native source copy observation only; not normal timing, physical peak memory or full appearance'};
function descendants(pid) {
  const pids=readdirSync('/proc').filter(value=>/^\d+$/.test(value));if(pids.length>65536)throw new Error('Process census cap');
  const processes=pids.map(processIdentity).filter(Boolean),ids=new Set([pid]);
  for(let step=0;step<32;step++) {
    const prior=ids.size;for(const item of processes)if(ids.has(item.ppid))ids.add(item.pid);
    if(ids.size===prior)return processes.filter(item=>ids.has(item.pid));
  }
  throw new Error('Descendant depth cap');
}
async function verify() {
  if(protocol&&JSON.stringify(await qualifyInputSubjects(provenance.builds))!==JSON.stringify(provenance.inputProof))throw new Error('Independent source/dependency proof changed');
  for(const arm of Object.keys(subjects)) {
    const build=provenance.builds[arm],dir=build.dir;
    if(build.revision!==subjects[arm]||execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim()!==subjects[arm])throw new Error('Subject revision moved');
    for(const [path,hash]of Object.entries(build.sourceInputs))if(await fileHash(join(dir,path))!==hash)throw new Error('Subject input changed');
    if(JSON.stringify(await inventory(join(dir,'apps/viewer/dist')))!==JSON.stringify(build.viewer))throw new Error('Frozen viewer assets changed');
  }
  for(const [path,hash]of Object.entries(provenance.harness.sourceInputs))if(await fileHash(join(root,path))!==hash)throw new Error('Controller input changed');
  if(await fileHash(provenance.fixture.file)!==FIXTURE.sha256)throw new Error('Fixture changed');
}
async function one(arm) {
  const build=provenance.builds[arm],path=join(output,`${arm}.json`),input=`${path}.input.json`;
  writeFileSync(input,JSON.stringify({arm,revision:subjects[arm],fixture:provenance.fixture,origin:servers[arm].origin,
    inputProtocol:protocol,inputProof:provenance.inputProof,chromeExecutableSha256:provenance.runtime.chromeExecutableSha256,
    defaultWasmPaths:build.viewer.filter(asset=>asset.sha256===build.wasmSha256).map(asset=>`/${asset.path}`)},null,2));
  const log=createWriteStream(`${path}.runner.log`,{flags:'wx'}),owned=new Map();
  const child=spawn('pnpm',['exec','tsx','scripts/perf/viewer-allocation-sample.mjs',input,path],{cwd:root,env:{...process.env,DEBUG:'pw:browser',DEBUG_COLORS:'0'},detached:true,stdio:['ignore','pipe','pipe']});
  const owner=child.pid&&processIdentity(child.pid);if(owner)owned.set(owner.pid,owner);
  let refusal,logBytes=0,closed=false,settle,exitTimer;const rss=[];
  const abort=reason=>{
    refusal??=reason;
    if(!closed&&canSignalGroup(owner,processIdentity(child.pid)))try{process.kill(-owner.pgrp,'SIGKILL');}catch(error){if(error.code!=='ESRCH')refusal+=`; ${error}`;}
    if(!closed)exitTimer??=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();settle?.({code:null,signal:'owned-close-deadline'});},30000);
  };activeAbort=abort;
  log.on('error',error=>abort(`Log write refused: ${error}`));
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logBytes+=chunk.length;if(logBytes>16*1024**2)abort('Log cap; tail uncertified');else log.write(chunk);});
  const timer=setTimeout(()=>abort('Control wall deadline'),900000);
  const monitor=setInterval(()=>{
    try {
      if(closed||!canSignalGroup(owner,processIdentity(child.pid)))return;
      const members=descendants(child.pid);
      if(!canSignalGroup(owner,processIdentity(child.pid)))throw new Error('Root identity changed during census');
      let bytes=0;for(const member of members){owned.set(member.pid,member);
        try{const current=processIdentity(member.pid);if(!current||current.startTime!==member.startTime)continue;
          bytes+=Number(readFileSync(`/proc/${member.pid}/status`,'utf8').match(/^VmRSS:\s+(\d+) kB$/m)?.[1]??0)*1024;
        }catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}}
      rss.push({atUTC:new Date().toISOString(),bytes});if(bytes>5*1024**3)abort('Owned sampled RSS ceiling');
    }catch(error){abort(String(error));}
  },250);
  const exit=await new Promise(resolveExit=>{settle=resolveExit;child.once('error',error=>{abort(String(error));resolveExit({code:null,spawnError:String(error)});});child.once('close',(code,signal)=>{closed=true;resolveExit({code,signal});});});
  clearInterval(monitor);clearTimeout(timer);clearTimeout(exitTimer);activeAbort=undefined;
  const deadline=Date.now()+30000;
  const [cleanup,flush]=await Promise.all([stopWitnessedProcesses([...owned.values()],30000).catch(error=>({status:'refused',reason:String(error)})),finishLog(log,Math.max(1,deadline-Date.now()))]);
  let row;try{row=JSON.parse(readFileSync(path,'utf8'));}catch(error){row={arm,revision:subjects[arm],status:'refused',reason:String(error)};}
  Object.assign(row,{exit,rootIdentity:owner,ownedCleanup:cleanup,logFlush:flush,backendErrors:backendErrors(readFileSync(`${path}.runner.log`,'utf8')),
    sampledRss:{samples:rss.length,peak:rss.reduce((max,p)=>Math.max(max,p.bytes),0),scope:'250ms aggregate owned RSS; shared pages double-counted; not physical peak'},hostAfter:{loadavg:readFileSync('/proc/loadavg','utf8')}});
  writeFileSync(`${path}.rss.json`,JSON.stringify(rss));
  if(refusal||exit.code!==0||cleanup.status!=='complete'||flush.status!=='complete'||row.teardown!=='complete'||row.backendErrors.length||!rss.length){row.status='refused';row.reason=refusal??row.reason??'Runtime/cleanup refusal';}
  writeFileSync(path,JSON.stringify(row,null,2));return row;
}
try {
  if(process.platform!=='linux'||process.env.CI!=='true')throw new Error('Fixed hosted Linux diagnostic only');
  for(const key of Object.keys(process.env))if(key.startsWith('VIEWER_BENCHMARK_'))throw new Error('Viewer option override refused');
  if(provenance.protocol!==protocol)throw new Error('Diagnostic protocol differs from frozen producer');
  if(provenance.fixture.sha256!==FIXTURE.sha256||provenance.fixture.size!==FIXTURE.size)throw new Error('Fixture provenance mismatch');
  await verify();report.initialFrozenInputs='complete';
  for(const arm of Object.keys(subjects))servers[arm]=await serveFrozen(join(provenance.builds[arm].dir,'apps/viewer/dist'),provenance.builds[arm].viewer);
  for(const arm of ['base','candidate']) {
    if(interrupted)throw new Error(`Interrupted by ${interrupted}`);
    await verify();const row=await one(arm);row.httpRequests=servers[arm].requests;rows.push(row);await verify();
    writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));if(row.status!=='allocation-observed')throw new Error(row.reason??'Control refused');
  }
  Object.assign(report,allocationVerdict(rows,interrupted,Boolean(protocol)));
  if(protocol){report.appearance=requireInputAppearancePair(rows);report.scope='Two instrumented final-head O-S1 canonical UI allocation/appearance correctness controls; no timing or physical-memory benefit';}
  report.requestedGraphics=GRAPHICS_PROFILE;
}catch(error){report.status='refused';report.reason=String(error);process.exitCode=1;}
finally {
  try {await verify();report.finalFrozenInputs='complete';}catch(error){report.status='refused';report.reason=String(error);report.finalFrozenInputs='refused';process.exitCode=1;}
  report.serverCleanup={};for(const [arm,server]of Object.entries(servers)){report.serverCleanup[arm]=await server.close(30000);if(report.serverCleanup[arm].status!=='complete'){report.status='refused';process.exitCode=1;}}
  if(interrupted){report.status='refused';report.reason=`Interrupted by ${interrupted}`;process.exitCode=1;}
  report.endedUTC=new Date().toISOString();
  try{writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));}finally{for(const [signal,handler]of handlers)process.removeListener(signal,handler);}
}
