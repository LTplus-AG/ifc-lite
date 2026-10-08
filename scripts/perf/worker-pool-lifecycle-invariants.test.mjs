/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {requireEpoch,ownedTree,requireSample,pairedReport} from './worker-pool-lifecycle-invariants.mjs';
const trace=()=>({loadId:'next',start:0,end:20,spans:['parser.complete','geometry.streamComplete','scene.finalize'].map(name=>({name,start:0,end:20}))});
const row=()=>({index:0,pair:1,side:'A',contrast:'c',workload:{name:'w'},source:'base',query:'warmPool=0',cleanup:{error:null},ok:true,identity:{complete:true,digest:'complete-source'},adapter:{vendor:'nvidia',isFallbackAdapter:false},memory:{rows:[{privateResidentBytes:30000,privateCommitBytes:40000,residentBytesSharedDoubleCount:50000,elapsedMs:1,rootPid:1,rootStart:1,processes:[{pid:1,parent:0,started:1,privateResidentBytes:30000,privateCommitBytes:40000,residentBytes:50000,lifetimePeakResidentBytes:55000}]}],maxGapMs:1,coverageEndElapsedMs:2},admission:[{quiet:true,main:{quiet:true},windows:{quiet:true}}],watcher:[{graphs:[]}],physical:[{admitted:true}],epochs:[{previousId:'prior',trace:trace(),metrics:{firstBatchWaitMs:3,firstVisibleGeometryMs:5,totalWallClockMs:10,metadataRenderReadyMs:12}}]});
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
