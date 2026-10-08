/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
const { metadataCompletionSpan } = await tsImport('../../tests/benchmark/metadata-render-readiness.ts', import.meta.url);
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function finiteNonnegative(value,name) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error(`Missing/nonfinite/negative ${name}`);
  return value;
}
export function requireEpoch(snapshot, previousId) {
  if (!snapshot || typeof snapshot.loadId!=='string' || !snapshot.loadId.trim() || snapshot.loadId === previousId) throw Error('Missing fresh load epoch');
  const end=finiteNonnegative(snapshot.end,'load.end'),start=finiteNonnegative(snapshot.start,'load.start');
  if(end<start)throw Error('Load end precedes start');
  if(!Array.isArray(snapshot.spans))throw Error('Missing actual span array');
  const ended=[];
  for(const span of snapshot.spans){
    finiteNonnegative(span.start,'span.start');
    if(span.end===null)continue;
    if(finiteNonnegative(span.end,'span.end')<span.start)throw Error('Span end precedes start');
    ended.push(span);
  }
  if (ended.some(s => s.name === 'parser.failed' || s.attrs?.error === true)) throw Error('Failed load span');
  for (const name of [metadataCompletionSpan(snapshot.attrs?.loadPath),'geometry.streamComplete','scene.finalize']) {
    if (!ended.some(s => s.name === name)) throw Error(`Missing finished ${name}`);
  }
  return snapshot;
}
function processId(value,name,allowZero=false) {
  if(!Number.isSafeInteger(value)||value<(allowZero?0:1))throw Error(`Missing/invalid ${name}`);
  return value;
}
function creationStamp(value,name) {
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return BigInt(value);
  if(typeof value==='string'&&/^\d{1,30}$/.test(value)&&BigInt(value)>0n)return BigInt(value);
  throw Error(`Missing/invalid ${name}`);
}
export function ownedTree(processes, rootPid, rootStart, previouslyOwned=[]) {
  processId(rootPid,'rootPid');const rootStamp=creationStamp(rootStart,'rootStart');
  if(!Array.isArray(processes))throw Error('Missing process identity records');
  const seen=new Set();
  for(const p of processes){processId(p.pid,'process.pid');processId(p.parent,'process.parent',true);creationStamp(p.started,'process.started');if(seen.has(p.pid))throw Error('Duplicate process PID record');seen.add(p.pid);}
  const root=processes.find(p=>p.pid===rootPid && creationStamp(p.started,'process.started')===rootStamp);
  if (!root) throw Error('Owned browser root missing or PID reused');
  const selected=new Map([[root.pid,root]]);
  for(const owned of previouslyOwned){processId(owned.pid,'prior process.pid');const priorStamp=creationStamp(owned.started,'prior process.started');const live=processes.find(p=>p.pid===owned.pid&&creationStamp(p.started,'process.started')===priorStamp);if(live)selected.set(live.pid,live);}
  let changed=true;
  while(changed){changed=false;for(const p of processes){
    if (!selected.has(p.pid) && selected.has(p.parent) && creationStamp(p.started,'process.started')>=creationStamp(selected.get(p.parent).started,'parent.started')){selected.set(p.pid,p);changed=true;}
  }}
  return [...selected.values()].sort((a,b)=>a.pid-b.pid);
}
export function requireSample(row) {
  if (row.ok!==true || !row.cleanup || row.cleanup.error!==null) throw Error('Failed sample/cleanup');
  if (row.identity?.complete!==true || typeof row.identity.digest!=='string' || !row.identity.digest) throw Error('Incomplete payload identity');
  if (typeof row.adapter?.vendor!=='string' || !row.adapter.vendor.trim() || row.adapter.isFallbackAdapter !== false || /swiftshader|software|llvmpipe/i.test(JSON.stringify(row.adapter))) throw Error('Native renderer identity missing/software');
  if (!row.memory?.rows?.length || row.memory.rows.some(x=>x.error)) throw Error('Missing actual resident memory');
  finiteNonnegative(row.memory.maxGapMs,'memory.maxGapMs');
  const coverageEnd=finiteNonnegative(row.memory.coverageEndElapsedMs,'memory.coverageEndElapsedMs');
  let previous=0, derivedGap=0, previouslyOwned=[],owner=null;
  for(const reading of row.memory.rows){
    finiteNonnegative(reading.privateResidentBytes,'memory.privateResidentBytes');
    finiteNonnegative(reading.privateCommitBytes,'memory.privateCommitBytes');
    finiteNonnegative(reading.residentBytesSharedDoubleCount,'memory.residentBytesSharedDoubleCount');
    if(!Array.isArray(reading.processes)||!reading.processes.length)throw Error('Missing native ownership process records');
    if(owner&&(owner.pid!==reading.rootPid||owner.start!==creationStamp(reading.rootStart,'rootStart')))throw Error('Owned root identity changed');
    owner={pid:reading.rootPid,start:creationStamp(reading.rootStart,'rootStart')};
    const owned=ownedTree(reading.processes,reading.rootPid,reading.rootStart,previouslyOwned);
    if(owned.length!==reading.processes.length)throw Error('Foreign/stale process in owned memory report');
    let resident=0,commit=0,shared=0;for(const process of owned){resident+=finiteNonnegative(process.privateResidentBytes,'process.privateResidentBytes');commit+=finiteNonnegative(process.privateCommitBytes,'process.privateCommitBytes');shared+=finiteNonnegative(process.residentBytes,'process.residentBytes');finiteNonnegative(process.lifetimePeakResidentBytes,'process.lifetimePeakResidentBytes');}
    if(resident!==reading.privateResidentBytes||commit!==reading.privateCommitBytes||shared!==reading.residentBytesSharedDoubleCount)throw Error('Owned process memory sum mismatch');
    previouslyOwned=owned;
    const elapsed=finiteNonnegative(reading.elapsedMs,'memory.elapsedMs');if(elapsed<previous)throw Error('Memory observation time reversed');derivedGap=Math.max(derivedGap,elapsed-previous);previous=elapsed;
  }
  if(coverageEnd<previous)throw Error('Resident interval end precedes final observation');
  derivedGap=Math.max(derivedGap,coverageEnd-previous);
  if(row.memory.maxGapMs!==derivedGap)throw Error('Reported resident gap differs from derived observation/edge gaps');
  if (derivedGap>2000) throw Error('Resident sampler observation gap');
  if (!row.admission?.length || !row.admission.every(x=>x.quiet===true && x.main?.quiet===true && x.windows?.quiet===true)) throw Error('Host admission failed');
  if (!row.watcher?.length || row.watcher.some(x=>x.graphs.length)) throw Error('Competing observable graph');
  if (!row.physical?.length || !row.physical.every(x=>x.admitted===true)) throw Error('Physical session admission failed');
  if(!row.epochs?.length)throw Error('Missing actual lifecycle epochs');
  for(const e of row.epochs){requireEpoch(e.trace,e.previousId);
    for(const name of ['firstBatchWaitMs','firstVisibleGeometryMs','totalWallClockMs','metadataRenderReadyMs'])if(!(name==='firstBatchWaitMs'&&e.trace.attrs?.loadPath==='cache'))finiteNonnegative(e.metrics?.[name],`timing.${name}`);
  }
  return row;
}
export function pairedReport(rows, schedule) {
  if(rows.length!==schedule.length)throw Error('Incomplete cohort; no substitution');
  const groups=new Map();
  for(let i=0;i<rows.length;i++){
    const row=requireSample(rows[i]), expected=schedule[i];
    if(row.index!==expected.index || row.side!==expected.side || row.pair!==expected.pair || row.contrast!==expected.contrast || row.workload?.name!==expected.workload.name || row.source!==expected.source || row.query!==expected.query)throw Error('Schedule reordered or replaced');
    const key=`${expected.contrast}/${expected.workload.name}/${expected.pair}`;
    const pair=groups.get(key)??[];pair.push(row);groups.set(key,pair);
  }
  return [...groups].map(([key,pair])=>{
    if(pair.length!==2 || new Set(pair.map(x=>x.side)).size!==2)throw Error('Incomplete pair');
    if(pair[0].identity.digest!==pair[1].identity.digest)throw Error('Payload identity mismatch');
    const a=pair.find(r=>r.side==='A'),b=pair.find(r=>r.side==='B');
    if(a.epochs.length!==b.epochs.length)throw Error('Lifecycle epoch count mismatch');
    const epochs=a.epochs.map((epoch,index)=>({index,fixture:epoch.fixture,metrics:Object.fromEntries(['firstBatchWaitMs','firstVisibleGeometryMs','totalWallClockMs','metadataRenderReadyMs'].map(name=>{const av=epoch.metrics[name],bv=b.epochs[index].metrics[name];return [name,{base:av,candidate:bv,deltaMs:Number.isFinite(av)&&Number.isFinite(bv)?bv-av:null,ratio:av>0&&Number.isFinite(bv)?bv/av:null}];}))}));
    return {key,identical:true,rows:pair.map(x=>x.index),performanceAdmitted:pair.every(r=>r.performanceAdmitted===true&&r.mode==='timing'&&r.memory.identityDuringInterval===false),epochs};
  });
}
