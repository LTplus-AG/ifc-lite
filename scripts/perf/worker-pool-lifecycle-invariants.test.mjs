/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fixtureSchedule from './worker-pool-lifecycle-schedule.fixture.json' with {type:'json'};
import {requireEpoch,ownedTree,requireSample,pairedReport} from './worker-pool-lifecycle-invariants.mjs';
const trace=()=>({loadId:'next',timeOrigin:1000,attrs:{loadPath:'wasm'},start:0,end:20,spans:['parser.complete','geometry.streamComplete','scene.finalize'].map(name=>({name,start:0,end:20}))});
const row=()=>({index:0,pair:1,side:'A',contrast:'c',workload:{name:'w',mode:'replace',loads:['fzk']},source:'base',query:'warmPool=0',cleanup:{error:null},ok:true,identity:{complete:true,digest:'complete-source'},adapter:{vendor:'nvidia',isFallbackAdapter:false},memory:{rows:[{privateResidentBytes:30000,privateCommitBytes:40000,residentBytesSharedDoubleCount:50000,elapsedMs:1,rootPid:1,rootStart:1,processes:[{pid:1,parent:0,started:1,privateResidentBytes:30000,privateCommitBytes:40000,residentBytes:50000,lifetimePeakResidentBytes:55000}]}],maxGapMs:1,coverageEndElapsedMs:2},admission:[{quiet:true,main:{quiet:true},windows:{quiet:true}}],watcher:[{graphs:[]}],physical:[{admitted:true}],epochs:[{fixture:'fzk',pageGeneration:0,pageTimeOrigin:1000,reloadCompleted:false,previousId:'prior',trace:trace(),metrics:{firstBatchWaitMs:3,firstVisibleGeometryMs:5,totalWallClockMs:20,metadataRenderReadyMs:25}}]});
test('#7036 new epoch cannot reuse an ended old root or skip actual finalize',()=>{
 assert.throws(()=>requireEpoch(trace(),'next'),/fresh/);
 const incomplete=trace();incomplete.spans.pop();assert.throws(()=>requireEpoch(incomplete,'prior'),/scene.finalize/);
 const failed=trace();failed.spans[0].attrs={error:true};assert.throws(()=>requireEpoch(failed,'prior'),/Failed/);
 assert.equal(requireEpoch(trace(),'prior').loadId,'next');
});
test('#7036 ownership excludes foreign profile roots, stale PID descendants and handles arbitrary input order',()=>{
 const processes=[{pid:3,parent:2,started:3},{pid:9,parent:8,started:10},{pid:2,parent:1,started:2},{pid:8,parent:0,started:1},{pid:1,parent:0,started:1},{pid:10,parent:2,started:1}];
 assert.deepEqual(ownedTree(processes,1,1).map(x=>x.pid),[1,2,3]);
 assert.throws(()=>ownedTree(processes,1,99),/PID reused/);
 assert.throws(()=>ownedTree(processes,22,1),/missing/);
});
test('#7036 native report rejects incomplete identity, estimated-only memory, software GPU, contamination and sampler gaps',()=>{
 for(const mutate of [r=>r.identity.complete=false,r=>r.memory.rows=[{idleBytes:100}],r=>r.adapter.vendor='SwiftShader',r=>r.watcher[0].graphs.push({pid:123}),r=>r.memory.maxGapMs=2100,r=>r.physical=[],r=>r.epochs[0].metrics.firstVisibleGeometryMs=null]){
  const r=row();mutate(r);assert.throws(()=>requireSample(r));
 }
 assert.equal(requireSample(row()).ok,true);
});
test('#7036 pair completeness refuses missing, reordered or substituted failed rows and changed actual payload',()=>{
 const a=row(),b={...row(),index:1,side:'B'};
 const schedule=[a,b].map(r=>({index:r.index,side:r.side,pair:1,contrast:r.contrast,workload:r.workload,source:r.source,query:r.query}));
 assert.equal(pairedReport([a,b],schedule).length,1);
 assert.throws(()=>pairedReport([a],schedule),/Incomplete/);
 assert.throws(()=>pairedReport([b,a],schedule),/reordered/);
 const changed={...b,identity:{complete:true,digest:'different'}};assert.throws(()=>pairedReport([a,changed],schedule),/mismatch/);
 assert.throws(()=>pairedReport([a,{...b,ok:false}],schedule),/Failed/);
});

test('#7036 truncated, null, NaN and negative native receipts cannot become acceptance',()=>{
 for(const value of [undefined,null,NaN,-1,Infinity]){
  const truncated=trace();truncated.end=value;assert.throws(()=>requireEpoch(truncated,'prior'));
  const span=trace();span.spans[0].end=value;assert.throws(()=>requireEpoch(span,'prior'));
  for(const mutate of [r=>r.memory.maxGapMs=value,r=>r.memory.rows[0].privateResidentBytes=value,r=>r.epochs[0].metrics.firstVisibleGeometryMs=value]){const r=row();mutate(r);assert.throws(()=>requireSample(r));}
 }
 for(const id of [undefined,null,'']){const t=trace();t.loadId=id;assert.throws(()=>requireEpoch(t,'prior'));}
});
test('#7036 live owned orphan remains attributed after its intermediate parent exits; reused PID remains excluded',()=>{
 const before=[{pid:1,parent:0,started:1},{pid:2,parent:1,started:2},{pid:3,parent:2,started:3}];
 const admitted=ownedTree(before,1,1);
 const now=[before[0],before[2],{pid:2,parent:99,started:20}];
 assert.deepEqual(ownedTree(now,1,1,admitted).map(p=>p.pid),[1,3]);
});

test('#7036 production report ownership validation refuses injected foreign processes and false total sums',()=>{
 const foreign=row();foreign.memory.rows[0].processes.push({pid:99,parent:88,started:2});assert.throws(()=>requireSample(foreign),/Foreign/);
 const sum=row();sum.memory.rows[0].privateResidentBytes=1;assert.throws(()=>requireSample(sum),/sum mismatch/);
 const root=row();delete root.memory.rows[0].rootStart;assert.throws(()=>requireSample(root),/Missing/);
});

test('#7036 lifecycle oracle shares actual cached metadata route and rejects misplaced cached marker on fresh load',()=>{
 const cached=trace();cached.attrs={loadPath:'cache'};cached.spans[0].name='cache.storeReady';assert.equal(requireEpoch(cached,'prior').loadId,'next');
 assert.throws(()=>requireEpoch({...cached,attrs:{loadPath:'wasm'}},'prior'),/parser.complete/);
});

test('#7036 derived observation gaps include start/end edges and refuse a false gap summary',()=>{
 const gap=row();gap.memory.rows.push({...gap.memory.rows[0],elapsedMs:100001});gap.memory.coverageEndElapsedMs=100002;assert.throws(()=>requireSample(gap),/gap/);
 const tail=row();tail.memory.coverageEndElapsedMs=100000;assert.throws(()=>requireSample(tail),/gap/);
 const start=row();start.memory.rows[0].elapsedMs=5000;start.memory.coverageEndElapsedMs=5001;assert.throws(()=>requireSample(start),/gap/);
 const sum=row();sum.memory.rows[0].residentBytesSharedDoubleCount=1;assert.throws(()=>requireSample(sum),/sum mismatch/);
});

test('#7036 production report cannot match absent root and process identity fields',()=>{
 const valid=row();assert.equal(requireSample(valid).ok,true);
 const ids=row();delete ids.memory.rows[0].rootPid;delete ids.memory.rows[0].processes[0].pid;assert.throws(()=>requireSample(ids),/rootPid/);
 const stamps=row();delete stamps.memory.rows[0].rootStart;delete stamps.memory.rows[0].processes[0].started;assert.throws(()=>requireSample(stamps),/rootStart/);
 const unsafe=row();unsafe.memory.rows[0].rootStart=Number.MAX_SAFE_INTEGER+1;unsafe.memory.rows[0].processes[0].started=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>requireSample(unsafe),/rootStart/);
 const ticks=row();ticks.memory.rows[0].rootStart='639007040001234567';ticks.memory.rows[0].processes[0].started='639007040001234567';assert.equal(requireSample(ticks).ok,true);
});

test('#7036 lifecycle report derives adjacent epoch identity and rejects duplicate or misdeclared predecessors',()=>{
 const duplicate=row();duplicate.workload.loads.push('fzk');duplicate.epochs.push(structuredClone(duplicate.epochs[0]));assert.throws(()=>requireSample(duplicate),/epoch|Epoch/);
 const chain=row();const second=structuredClone(chain.epochs[0]);second.trace.loadId='third';second.previousId=chain.epochs[0].trace.loadId;chain.workload.loads.push('fzk');chain.epochs.push(second);assert.equal(requireSample(chain).ok,true);
 const bad=structuredClone(chain);bad.epochs[1].previousId='invented';assert.throws(()=>requireSample(bad),/epoch|Epoch/);
 const revisit=structuredClone(chain);const third=structuredClone(chain.epochs[0]);third.previousId='third';revisit.workload.loads.push('fzk');revisit.epochs.push(third);assert.throws(()=>requireSample(revisit),/epoch|Epoch/);
});

test('#7036 cache page reload admits fresh generation while same-page replacement requires adjacent predecessor',()=>{
 const cached=row();cached.workload={name:'cache',mode:'cache',loads:['fzk','fzk']};const next=structuredClone(cached.epochs[0]);next.trace.loadId='cache-next';next.trace.attrs={loadPath:'cache'};next.trace.spans[0].name='cache.storeReady';next.previousId=null;next.pageGeneration=1;next.pageTimeOrigin=2000;next.trace.timeOrigin=2000;next.reloadCompleted=true;cached.epochs.push(next);assert.equal(requireSample(cached).ok,true);
 const invented=structuredClone(cached);invented.workload.mode='replace';assert.throws(()=>requireSample(invented),/generation/);
 const stale=structuredClone(cached);stale.epochs[1].previousId='next';assert.throws(()=>requireSample(stale),/previous page/);
});

test('#7036 reload flags cannot substitute observed distinct browser time origin',()=>{
 const cached=row();cached.workload={name:'cache',mode:'cache',loads:['fzk','fzk']};const next=structuredClone(cached.epochs[0]);next.trace.loadId='cache-next';next.trace.attrs={loadPath:'cache'};next.trace.spans[0].name='cache.storeReady';next.previousId=null;next.pageGeneration=1;next.reloadCompleted=true;cached.epochs.push(next);assert.throws(()=>requireSample(cached),/origin/);
 next.pageTimeOrigin=2000;next.trace.timeOrigin=2000;assert.equal(requireSample(cached).ok,true);
 const missing=structuredClone(cached);delete missing.epochs[1].pageTimeOrigin;assert.throws(()=>requireSample(missing),/pageTimeOrigin/);
 const unobserved=structuredClone(cached);unobserved.epochs[1].reloadCompleted=false;assert.throws(()=>requireSample(unobserved),/reload completion/);
});

test('#7036 actual planned replace/cache cohort refuses missing, reordered, substituted fixtures and same-name mode changes',()=>{
 const schedule=fixtureSchedule.rows.slice(0,2);
 const make=spec=>{const sample={...row(),...structuredClone(spec)};sample.epochs=spec.workload.loads.map((fixture,index)=>({...structuredClone(row().epochs[0]),fixture,previousId:index?`epoch-${index-1}`:null,trace:{...trace(),loadId:`epoch-${index}`}}));return sample;};
 const rows=schedule.map(make);assert.equal(pairedReport(rows,schedule).length,1);
 const missing=structuredClone(rows);for(const sample of missing)sample.epochs.pop();assert.throws(()=>pairedReport(missing,schedule),/count/);
 const order=structuredClone(rows);for(const sample of order)[sample.epochs[0].fixture,sample.epochs[1].fixture]=[sample.epochs[1].fixture,sample.epochs[0].fixture];assert.throws(()=>pairedReport(order,schedule),/fixture/);
 const substituted=structuredClone(rows);substituted[1].epochs[1].fixture='fzk';assert.throws(()=>pairedReport(substituted,schedule),/fixture/);
 const mode=structuredClone(rows);for(const sample of mode)sample.workload.mode='immediate';assert.throws(()=>pairedReport(mode,schedule),/workload/);
 const altered=structuredClone(rows);for(const sample of altered)sample.workload.loads[1]='fzk';for(const sample of altered)sample.epochs[1].fixture='fzk';assert.throws(()=>pairedReport(altered,schedule),/workload/);
 const cachedSchedule=fixtureSchedule.rows.slice(2);const cached=cachedSchedule.map(make);for(const sample of cached){sample.epochs[1].pageGeneration=1;sample.epochs[1].pageTimeOrigin=2000;sample.epochs[1].trace.timeOrigin=2000;sample.epochs[1].reloadCompleted=true;sample.epochs[1].previousId=null;sample.epochs[1].trace.attrs={loadPath:'cache'};sample.epochs[1].trace.spans[0].name='cache.storeReady';}assert.equal(pairedReport(cached,cachedSchedule).length,1);
});

test('#7036 first observed epoch rejects the pre-load root and routes are bound to immutable cache plan',()=>{
 const old=row();old.epochs[0].previousId=old.epochs[0].trace.loadId;assert.throws(()=>requireSample(old),/fresh/);
 const absent=row();delete absent.epochs[0].previousId;assert.throws(()=>requireSample(absent),/previous epoch/);
 const idle=row();idle.workload={name:'idle-ready',mode:'idle-ready',first:'fzk'};assert.equal(requireSample(idle).ok,true);
 const cache=row();cache.workload={name:'cache',mode:'cache',loads:['fzk','fzk']};const next=structuredClone(cache.epochs[0]);next.trace.loadId='cached';next.previousId=null;next.pageGeneration=1;next.pageTimeOrigin=2000;next.trace.timeOrigin=2000;next.reloadCompleted=true;cache.epochs.push(next);assert.throws(()=>requireSample(cache),/load path/);
 next.trace.attrs.loadPath='cache';next.trace.spans[0].name='cache.storeReady';assert.equal(requireSample(cache).ok,true);
 const fresh=row();fresh.epochs[0].trace.attrs.loadPath='cache';fresh.epochs[0].trace.spans[0].name='cache.storeReady';assert.throws(()=>requireSample(fresh),/load path/);
});

test('#7036 copied old-page trace cannot borrow a fresh observed page time origin',()=>{
 const old=row();old.epochs[0].pageTimeOrigin=2000;assert.throws(()=>requireSample(old),/Trace time origin/);
 const missing=row();delete missing.epochs[0].trace.timeOrigin;assert.throws(()=>requireSample(missing),/timeOrigin/);
 const invalid=row();invalid.epochs[0].trace.timeOrigin=NaN;assert.throws(()=>requireSample(invalid),/timeOrigin/);
});

test('#7180 readiness cannot be zero or predate actual metadata, geometry and finalize completion',()=>{
 const valid=row();valid.epochs[0].metrics.metadataRenderReadyMs=25;assert.equal(requireSample(valid).ok,true);
 const a=structuredClone(valid),b={...structuredClone(valid),index:1,side:'B'};const schedule=[a,b];for(const sample of [a,b])sample.epochs[0].metrics.metadataRenderReadyMs=0;assert.throws(()=>pairedReport([a,b],schedule),/readiness/);
 for(const value of [0,19]){
  const early=structuredClone(valid);early.epochs[0].metrics.metadataRenderReadyMs=value;
  assert.throws(()=>requireSample(early),/readiness/);
 }
 const fabricated=structuredClone(valid);Object.assign(fabricated.epochs[0].metrics,{metadataCompleteMs:0,streamCompleteMs:0,metadataRenderReadyMs:15});assert.throws(()=>requireSample(fabricated),/readiness/);
 for(const name of ['parser.complete','geometry.streamComplete','scene.finalize']){
  const late=structuredClone(valid);late.epochs[0].trace.spans.find(span=>span.name===name).end=30;assert.throws(()=>requireSample(late),/readiness/);
 }
 // The observed readiness endpoint excludes later trace.finish/model bookkeeping.
 const root=structuredClone(valid);root.epochs[0].trace.end=30;assert.equal(requireSample(root).ok,true);
 const cached=structuredClone(valid);cached.workload={name:'cache',mode:'cache',loads:['fzk','fzk']};const next=structuredClone(cached.epochs[0]);next.previousId=null;next.trace.loadId='cache-next';next.trace.attrs.loadPath='cache';next.trace.spans[0].name='cache.storeReady';next.trace.spans[0].end=30;next.pageGeneration=1;next.reloadCompleted=true;next.pageTimeOrigin=2000;next.trace.timeOrigin=2000;cached.epochs.push(next);assert.throws(()=>requireSample(cached),/readiness/);
});
