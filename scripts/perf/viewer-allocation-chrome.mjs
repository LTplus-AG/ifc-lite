/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import {readdirSync,readFileSync,readlinkSync} from 'node:fs';
import {processIdentity} from './interleaved-cleanup.mjs';
import {fileHash} from './interleaved-assets.mjs';
export function selectChrome(records,parentPid,flags) {
  const mains=records.filter(row=>row.identity.ppid===parentPid && /^(chrome|google-chrome(?:-stable)?)$/.test(row.argv[0]?.split('/').at(-1)??'')
    && !row.argv.some(arg=>arg==='--type'||arg.startsWith('--type=')));
  if(mains.length!==1)throw new Error('Exactly one directly owned Chrome main required');
  const main=mains[0];
  for(const flag of flags) {
    const key=flag.split('=')[0],actual=main.argv.filter(arg=>arg.split('=')[0]===key);
    const screenshotDefault=key==='--enable-features'&&actual.length===2&&actual[0]==='--enable-features=CDPScreenshotNewSurface';
    if((actual.length!==1&&!screenshotDefault)||actual.at(-1)!==flag)throw new Error('Actual Chrome profile mismatch');
  }
  return main;
}
export async function ownedChrome(flags) {
  const pids=readdirSync('/proc').filter(value=>/^\d+$/.test(value)),records=[];
  if(pids.length>4096)throw new Error('Process census cap');
  const verify=witness=>{const current=processIdentity(witness.pid);
    if(!current||current.startTime!==witness.startTime||current.ppid!==process.pid||witness.ppid!==process.pid)throw new Error('Chrome ownership changed');};
  for(const pid of pids) {
    const identity=processIdentity(pid);if(!identity||identity.ppid!==process.pid)continue;
    verify(identity);const raw=readFileSync(`/proc/${pid}/cmdline`);verify(identity);
    if(raw.length>65536||records.length>=16)throw new Error('Owned argv cap');
    records.push({identity,argv:raw.toString('utf8').split('\0').filter(Boolean)});
  }
  const main=selectChrome(records,process.pid,flags);verify(main.identity);
  const executable=readlinkSync(`/proc/${main.identity.pid}/exe`);verify(main.identity);
  if(!/^(chrome|google-chrome(?:-stable)?)$/.test(executable.split('/').at(-1)))throw new Error('Not actual Chrome executable');
  const sha256=await fileHash(`/proc/${main.identity.pid}/exe`);verify(main.identity);
  return {...main,executable,sha256};
}
