/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync } from 'node:fs';
import { diffModels } from '../packages/diff/dist/index.js';
const e = (key, lo, hi, volume, extra = {}) => ({ key, ref: key, ifcType:'IfcWall',
  dataHash:key, geometryHash:key, aabb:{min:[lo,0,0], max:[hi,1,1]},
  ...(volume === undefined ? {} : {volume}), ...extra });
const whole = () => e('whole',0,10,10);
const pieces = () => [e('z',0,4,4),e('a',4,10,6)];
const cases = [];
const add = (name,base,head,options={}) => cases.push({name,base,head,options});
add('verified', [whole()], pieces());
add('extent', [e('whole',0,10)], pieces());
add('partial-refutation', [whole()], [e('a',0,4,11),e('b',4,10)]);
add('undershoot', [whole()], [e('a',0,4,2),e('b',4,10,2)]);
add('interloper', [whole()], [...pieces(),e('intruder',2,3,2)]);
add('ambiguous-interloper', [whole()], [e('a',0,5,5),e('b',5,10,5),e('c',2,7,5)]);
add('coincident-without-volume', [e('whole',0,10)], [e('a',0,10),e('b',0,10)]);
add('coincident-with-volume', [whole()], [e('a',0,10,4),e('b',0,10,6)]);
add('displaced', [whole()], [e('a',20,24,4),e('b',24,30,6)]);
add('two-displaced-wholes', [whole(),e('second',40,50,10)], [e('a',20,24,4),e('b',24,30,6)]);
add('two-displaced-clusters', [whole()], [e('a',20,24,4),e('b',24,30,6),e('c',40,44,4),e('d',44,50,6)]);
for (const count of [2,3,4]) add(`equal-conflicts-${count}`, Array.from({length:count},(_,i)=>e(`whole${i}`,0,10,10)),pieces());
add('family', [whole()],pieces().map(p=>({...p,ifcType:'IfcBuildingElementPart'})));
add('no-family', [whole()],pieces().map(p=>({...p,ifcType:'IfcCovering'})));
add('custom-family', [whole()],pieces().map(p=>({...p,ifcType:'IfcCovering'})), {classFamilies:[['IfcWall','IfcCovering']]});
add('empty-families', [whole()],pieces().map(p=>({...p,ifcType:'IfcBuildingElementPart'})), {classFamilies:[]});
add('duplicate-family-first-wins', [whole()],pieces().map(p=>({...p,ifcType:'IfcCovering'})), {classFamilies:[['Other','IfcCovering'],['IfcWall','IfcCovering']]});
add('geometry-abstention', [whole()],pieces(),{scope:'data'});
add('excluded', [whole()],pieces(),{excludeTypes:['IfcWall']});
add('content-retires-before-split', [whole()], [{...whole(),key:'renamed',ref:'renamed'},e('extra',1,2,1)]);
for (const cap of [-1,0,1,2,2.5,3,256]) add(`cap-${cap}`,[whole()],[e('a',0,3,3),e('b',3,6,3),e('c',6,10,4)],{maxSplitPieces:cap});
let seed=8042;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
for(let i=0;i<160;i++) {
  const length=1+Math.floor(random()*40), count=2+Math.floor(random()*5);
  const shift=i%3===0?100:0, missing=i%5===0, gap=i%7===0?0.3:0;
  const base=[e(`w${i}`,0,length,missing?undefined:length)];
  const head=Array.from({length:count},(_,j)=>e(`p${i}-${j}`,shift+j*length/count+(j?gap:0),shift+(j+1)*length/count,
    missing&&j===0?undefined:length/count*(i%11===0?0.9:1),{ifcType:i%4===0?'IfcWallStandardCase':'IfcWall'}));
  add(`generated-${i}`,base,head,{splitVolumeTolerance:i%9===0?0:0.03});
}
// Exercise the same evidence in both directions; neither direction retires entries.
const all=[...cases,...cases.map(c=>({...c,name:`merge-${c.name}`,base:c.head,head:c.base}))];
const vectors=all.map(input=>{
  const options={matchUnpairedByContent:true,detectSplitMerge:true,...input.options};
  const result=diffModels(input.base,input.head,options);
  return {...input,options,expected:{...result,byKey:[...result.byKey]}};
});
const path=new URL('../rust/diff/tests/split_vectors.json',import.meta.url);
const text=`[\n${vectors.map(v=>JSON.stringify(v)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {
  if(readFileSync(path,'utf8')!==text) throw new Error('Split/merge vectors differ from the built TypeScript engine');
} else writeFileSync(path,text);
console.log(`Split/merge parity: ${vectors.length} cases`);
