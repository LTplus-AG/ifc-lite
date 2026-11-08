/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
export const boundedNode=(argv,{cwd,env,deadline,budget,start})=>new Promise((done,reject)=>{
    const remaining=deadline-performance.now(); if(remaining<=0) return reject(new Error('Exercise budget exceeded'));
    const child=spawn(process.execPath,argv,{cwd:cwd,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',expired=false;
    child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
    const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},remaining);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(expired) reject(new Error(`Budget ${budget}s exceeded; elapsed ${((performance.now()-start)/1000).toFixed(1)}s`));else if(code!==0) reject(new Error(`${argv[1]} exited ${code}: ${stderr.slice(-1500)} ${stdout.slice(-500)}`));else done(stdout);});
  });
