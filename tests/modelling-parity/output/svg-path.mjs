/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const PARAMETERS={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};

/** Require complete path commands and at least one drawing operation.
 * This checks path syntax for sanity; it does not parse XML or certify shape.
 */
export function drawablePath(data) {
  const tokens=[];
  const token=/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gy;
  let offset=0;
  while(offset<data.length) {
    const separator=/^[\s,]+/.exec(data.slice(offset));
    if(separator) {offset+=separator[0].length;continue;}
    token.lastIndex=offset;
    const match=token.exec(data);
    if(!match) return false;
    tokens.push(/^[A-Za-z]$/.test(match[0])?match[0]:Number(match[0]));
    offset=token.lastIndex;
  }
  let i=0, first=true, drawable=false;
  while(i<tokens.length) {
    if(typeof tokens[i]!=='string') return false;
    const command=tokens[i++].toUpperCase(), size=PARAMETERS[command];
    if(first && command!=='M') return false;
    if(command==='Z') continue;
    const start=i;
    while(i<tokens.length && typeof tokens[i]==='number') i++;
    const values=tokens.slice(start,i);
    if(values.length<size || values.length%size!==0 || !values.every(Number.isFinite)) return false;
    if(command==='A') {
      for(let k=0;k<values.length;k+=size) {
        if(values[k]<0 || values[k+1]<0 || ![0,1].includes(values[k+3]) || ![0,1].includes(values[k+4])) return false;
      }
    }
    // Additional coordinate pairs after moveto are implicit lineto commands.
    if(command!=='M' || values.length>2) drawable=true;
    first=false;
  }
  return drawable;
}
