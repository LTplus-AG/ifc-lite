/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const PARAMETERS={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};

/** Require complete path commands and at least one drawing operation.
 * This checks path syntax for sanity; it does not parse XML or certify shape.
 */
export function drawablePath(data) {
  const tokens=[];
  const number=/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let offset=0, active='', parameters=0;
  while(offset<data.length) {
    const separator=/^\s*(,)?\s*/.exec(data.slice(offset))[0];
    if(separator.includes(',')) {
      // A comma separates two parameters, never a command or end of data.
      if(typeof tokens.at(-1)!=='number' || !/^[-+.0-9]/.test(data.slice(offset+separator.length))) return false;
    }
    offset+=separator.length;
    if(offset===data.length) break;
    const char=data[offset];
    if(/[MmLlHhVvCcSsQqTtAaZz]/.test(char)) {
      tokens.push(char); active=char.toUpperCase(); parameters=0; offset++; continue;
    }
    let value;
    if(active==='A' && [3,4].includes(parameters%7)) {
      if(char!=='0' && char!=='1') return false;
      value=Number(char); offset++;
    } else {
      number.lastIndex=offset;
      const match=number.exec(data);
      if(!match) return false;
      value=Number(match[0]); offset=number.lastIndex;
    }
    tokens.push(value); parameters++;
  }
  let i=0, first=true, drawable=false, current=[0,0], startPoint=[0,0];
  while(i<tokens.length) {
    if(typeof tokens[i]!=='string') return false;
    const raw=tokens[i++], command=raw.toUpperCase(), relative=raw!==command, size=PARAMETERS[command];
    if(first && command!=='M') return false;
    if(command==='Z') { drawable ||= current.some((v,k)=>v!==startPoint[k]); current=[...startPoint]; continue; }
    const start=i;
    while(i<tokens.length && typeof tokens[i]==='number') i++;
    const values=tokens.slice(start,i);
    if(values.length<size || values.length%size!==0 || !values.every(Number.isFinite)) return false;
    if(command==='A') {
      for(let k=0;k<values.length;k+=size) {
        if(values[k]<0 || values[k+1]<0 || ![0,1].includes(values[k+3]) || ![0,1].includes(values[k+4])) return false;
      }
    }
    for(let k=0;k<values.length;k+=size) {
      const group=values.slice(k,k+size);
      const point=(x,y)=>[x+(relative?current[0]:0),y+(relative?current[1]:0)];
      let points;
      if(command==='H') points=[[group[0]+(relative?current[0]:0),current[1]]];
      else if(command==='V') points=[[current[0],group[0]+(relative?current[1]:0)]];
      else if(command==='A') points=[point(group[5],group[6])];
      else { points=[]; for(let n=0;n<group.length;n+=2) points.push(point(group[n],group[n+1])); }
      if(!points.flat().every(Number.isFinite)) return false;
      if(command==='M' && k===0) startPoint=[...points[0]];
      else if(points.some(p=>p.some((v,n)=>v!==current[n]))) drawable=true;
      current=points.at(-1);
    }
    first=false;
  }
  return drawable;
}
