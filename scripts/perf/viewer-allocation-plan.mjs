/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { classifySourceSlices } from './viewer-source-slice-observer.mjs';
import { INPUT_SUBJECTS } from './input-witness-integration.mjs';
export const SUBJECTS = Object.freeze({base:'c61932d4a9d85efe1b0f817a5274a115f0571ee3', candidate:'2feb6545b588e02d55d4d6b4d9afbe8be261452e'});
export const FIXTURE = Object.freeze({path:'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc',size:342657851,
  sha256:'e91ddbbd672bbde946af14631de4c732f0cf8a7cfae5dbbf06fbeab03b5c46df'});
export function allocationVerdict(rows, interrupted, independentInput = false) {
  if (typeof independentInput !== 'boolean') throw new Error('REFUSE: unknown allocation protocol');
  const subjects = independentInput ? INPUT_SUBJECTS : SUBJECTS;
  if (interrupted || rows.length !== 2 || rows[0].arm !== 'base' || rows[1].arm !== 'candidate')
    throw new Error('REFUSE: two fixed ordered controls required without interruption');
  for (const row of rows) if (row.revision !== subjects[row.arm] || row.status !== 'allocation-observed'
    || row.ownedCleanup?.status !== 'complete' || row.logFlush?.status !== 'complete' || row.teardown !== 'complete'
    || row.allocation?.bytes!==FIXTURE.size || row.backendErrors?.length || !(row.sampledRss?.samples > 0) || row.sampledRss.peak > 5*1024**3)
    throw new Error('REFUSE: source revision, load, runtime or cleanup control incomplete');
  for(const row of rows) if(!row.chrome?.sha256||!row.chrome.version||!Number.isSafeInteger(row.runtime?.hardwareConcurrency)
    || row.runtime.hardwareConcurrency<1||!Number.isSafeInteger(row.runtime.workerCount)||row.runtime.workerCount<1
    || row.runtime.workerIds?.length!==row.runtime.workerCount||!row.runtime.crossOriginIsolated||!row.runtime.sharedArrayBuffer
    || !Number.isSafeInteger(row.allocation.owner?.entityCount)||row.allocation.owner.entityCount<1)throw new Error('REFUSE: missing actual runtime/owner census');
  if(rows[0].chrome.sha256!==rows[1].chrome.sha256||rows[0].chrome.version!==rows[1].chrome.version
    || rows[0].runtime.hardwareConcurrency!==rows[1].runtime.hardwareConcurrency
    || rows[0].runtime.workerCount!==rows[1].runtime.workerCount
    || JSON.stringify(rows[0].runtime.workerIds)!==JSON.stringify(rows[1].runtime.workerIds)
    || rows[0].allocation.owner.entityCount!==rows[1].allocation.owner.entityCount)throw new Error('REFUSE: runtime/owner census differs across controls');
  const copies=rows.map(row=>classifySourceSlices(row.allocation));
  if (copies[0].filter(call=>call.attribution==='source-preparation-before-default-pool' && call.inputKind==='SharedArrayBuffer').length!==1
    || copies[1].some(call=>call.attribution==='source-preparation-before-default-pool'))
    throw new Error('REFUSE: prescribed baseline one/candidate zero preparation-copy mechanism not observed');
  return {status:'allocation-controls-complete',copies,
    scope:'One native full-source preparation copy removed; possible admitted cache copies retained. No normal timing, physical-memory or full-appearance verdict.'};
}
export function canSignalGroup(owner,current) {
  return Boolean(owner && current && owner.pid===current.pid && owner.startTime===current.startTime
    && owner.pgrp===owner.pid && current.pgrp===owner.pgrp && current.state!=='Z');
}
export function backendErrors(log) {
  return log.split('\n').filter(line=>/Could not find a SharedImageBackingFactory|Unable to create SkSurface|VK_ERROR|GPU process.*(?:crash|exited unexpectedly)|(?:Dawn|SharedImage|Vulkan).*(?:failed|failure|error)|(?:ERROR|failed|failure).*(?:Dawn|SharedImage|Vulkan)/i.test(line));
}

export function requireFixedDispatch(baseRef,candidateRef) {
  if(baseRef||candidateRef)throw new Error('REFUSE: fixed allocation route cannot mix paired-ref inputs');
  return SUBJECTS;
}
