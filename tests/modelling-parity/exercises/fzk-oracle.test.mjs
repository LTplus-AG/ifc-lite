/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFzk } from './fzk-oracle.mjs';
import { target } from './fzk.mjs';

// #9314: the target's roof is two IfcSlab(ROOF) planes. The oracle must
// accept that representation and still reject a flat replacement.
test('#9314 roof slab planes pass the reference roof checks; flat planes fail', () => {
  const text="#1=IFCSLAB('a',$,$,$,$,$,$,$,.ROOF.);\n#2=IFCSLAB('b',$,$,$,$,$,$,$,.ROOF.);";
  const plane=(slope)=>{
    const width=10, depth=target.roof.totalUpwardArea/(2*width*Math.sqrt(1+slope*slope));
    const a=[0,0,0],b=[width,0,0],c=[0,depth*slope,depth],d=[width,depth*slope,depth];
    return {min:[0,0,0],max:[width,depth*slope,depth],triangles:[[a,c,b],[b,c,d]]};
  };
  const inspect=(slope)=>{
    const rows=[];
    compareFzk({text,find:id=>plane(id===1?slope:-slope),levels:[],emit:(name,cap,status)=>rows.push({name,status})});
    return rows.filter(r=>['reference-gable-roof','reference-roof-area'].includes(r.name));
  };
  assert.deepEqual(inspect(Math.tan(Math.PI/6)).map(r=>r.status),['pass','pass']);
  assert.equal(inspect(0).find(r=>r.name==='reference-gable-roof').status,'fail');
});
