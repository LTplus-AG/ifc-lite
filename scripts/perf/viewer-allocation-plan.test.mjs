/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import {test} from 'node:test';import assert from 'node:assert/strict';
import {SUBJECTS,FIXTURE,allocationVerdict,canSignalGroup,backendErrors,requireFixedDispatch} from './viewer-allocation-plan.mjs';
import {selectChrome} from './viewer-allocation-chrome.mjs';
function rows(){return ['base','candidate'].map(arm=>({arm,revision:SUBJECTS[arm],status:'allocation-observed',teardown:'complete',
  chrome:{sha256:'f'.repeat(64),version:'fixed'},runtime:{hardwareConcurrency:2,workerCount:2,workerIds:[0,1],crossOriginIsolated:true,sharedArrayBuffer:true},
  ownedCleanup:{status:'complete'},logFlush:{status:'complete'},backendErrors:[],sampledRss:{samples:5,peak:100},
  allocation:{owner:{entityCount:10},bytes:FIXTURE.size,frozen:true,restorationExact:true,error:null,canonicalMetadataSource:{bytes:FIXTURE.size,sourceId:1},
    milestones:{sourceAcquired:1,parallelStart:3,geometryComplete:4,metadataComplete:5},
    calls:arm==='base'?[{sourceId:1,outputId:2,pageMs:2,inputKind:'SharedArrayBuffer',outputKind:'ArrayBuffer',
      wholeSourceBytesCopied:true,outputBytes:FIXTURE.size,outputBufferBytes:FIXTURE.size,outputByteOffset:0}]:[]}}));}
test('#6537 allocation policy requires complete pinned two-arm receipts and preparation mechanism',()=>{
  assert.equal(allocationVerdict(rows()).status,'allocation-controls-complete');
  for(const mutate of [r=>r.pop(),r=>r.reverse(),r=>r[0].revision=SUBJECTS.candidate,r=>r[0].ownedCleanup.status='refused',
    r=>r[1].allocation.bytes=8,r=>r[0].allocation.calls[0].pageMs=3.5,r=>r[1].allocation.calls=r[0].allocation.calls,
    r=>r[1].runtime.workerCount=3,r=>r[1].allocation.owner.entityCount=9,r=>r[1].chrome.version='other',r=>r[0].backendErrors.push('GPU failure'),r=>r[0].sampledRss.peak=6*1024**3]){
    const input=rows();mutate(input);assert.throws(()=>allocationVerdict(input),/REFUSE/);
  }
  assert.throws(()=>allocationVerdict(rows(),'SIGTERM'),/interruption/);
});
test('#6537 intentional full-appearance refusal cannot erase genuine completed allocation witness',()=>{
  const input=rows();input[0].fullAppearanceIdentity={status:'unavailable',reason:'unsupported authored text'};
  const result=allocationVerdict(input);assert.match(result.scope,/No normal timing/);
  assert.equal(input[0].fullAppearanceIdentity.status,'unavailable');
});
test('#6537 PID reuse and non-owned process groups never qualify for group signalling',()=>{
  const owner={pid:123,pgrp:123,startTime:'10',state:'S'};
  assert.equal(canSignalGroup(owner,{...owner,startTime:'11'}),false);
  assert.equal(canSignalGroup(owner,{...owner,pgrp:55}),false);
  assert.equal(canSignalGroup(owner,{...owner,state:'Z'}),false);
  assert.equal(canSignalGroup(owner,{...owner}),true);
});
test('#6537 Chrome provenance refuses foreign parent, duplicate mains and changed flags',()=>{
  const records=[{identity:{pid:2,ppid:1},argv:['/opt/google/chrome/chrome','--use-vulkan=swiftshader']}];
  assert.equal(selectChrome(records,1,['--use-vulkan=swiftshader']).identity.pid,2);
  assert.throws(()=>selectChrome(records,9,['--use-vulkan=swiftshader']),/owned Chrome/);
  assert.throws(()=>selectChrome([...records,...records],1,['--use-vulkan=swiftshader']),/owned Chrome/);
  assert.throws(()=>selectChrome(records,1,['--use-vulkan=other']),/profile mismatch/);
});
test('#6537 graphics backend faults remain refusal while unrelated DBus warnings do not',()=>{
  assert.equal(backendErrors('DBus connection refused').length,0);
  assert.equal(backendErrors('ERROR Dawn initialization failed').length,1);
});


test('#6537 fixed allocation dispatch refuses paired-ref mixing instead of silently substituting subjects',()=>{
  assert.equal(requireFixedDispatch('',''),SUBJECTS);
  assert.throws(()=>requireFixedDispatch(SUBJECTS.base,''),/mix paired-ref/);
  assert.throws(()=>requireFixedDispatch('',SUBJECTS.candidate),/mix paired-ref/);
});
