/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync } from 'node:fs';
import { diffModels } from '../packages/diff/dist/index.js';
const cases=JSON.parse(readFileSync(new URL('../rust/diff/tests/split_vectors.json',import.meta.url),'utf8'))
  .map(({expected,...v})=>({...v,name:`successor-${v.name}`}));
const e=(key,x,size=1,extra={})=>({key,ref:key,ifcType:'IfcWall',dataHash:key,geometryHash:key,
  aabb:{min:[x,0,0],max:[x+size,1,1]},container:'Site/Building/Storey',...extra});
const add=(name,base,head,options={})=>cases.push({name,base,head,options});
for(const x of [0,0.001,0.1,0.25,0.5,0.8,1,2]) {
  add(`shift-${x}`,[e('a',0)],[e('b',x)]);
  add(`missing-container-${x}`,[e('a',0,1,{container:''})],[e('b',x)]);
  add(`other-container-${x}`,[e('a',0)],[e('b',x,1,{container:'other'})]);
}
add('equal-footprints',[e('a',0)],[e('b',0),e('c',0)]);
add('position-tie',[e('a',0)],[e('b',-0.5),e('c',0.5)]);
add('cross-class-components',[e('a',0,1,{components:{z:'yes','𐀀':'yes','':'yes',x:'old'}})],
 [e('b',0,1,{ifcType:'IfcBuildingElementPart',components:{z:'yes','𐀀':'yes','':'yes',x:'new'}})]);
add('size-refusal',[e('a',0)],[e('b',0.6,3)]);
add('flat-position',[e('a',0,0)],[e('b',0.3,0)]);
for(const overlap of [-1,0,0.2,0.6,1,2]) add(`overlap-${overlap}`,[e('a',0)],[e('b',0.2)],{successorOverlap:overlap});
for(const size of [1024,1025]) add(`budget-${size}`,
 Array.from({length:size},(_,i)=>e(`a${i}`,i*10)), Array.from({length:size},(_,i)=>e(`b${i}`,i*10)));
const vectors=cases.map(input=>{
 const options={matchUnpairedByContent:true,detectSplitMerge:true,...input.options,detectSuccessors:true};
 const result=diffModels(input.base,input.head,options);
 return {...input,options,expected:{...result,byKey:[...result.byKey]}};
});
const path=new URL('../rust/diff/tests/successor_vectors.json',import.meta.url);
const text=`[\n${vectors.map(v=>JSON.stringify(v)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {
 if(readFileSync(path,'utf8')!==text) throw new Error('Successor vectors differ from the built TypeScript engine');
} else writeFileSync(path,text);
console.log(`Successor parity: ${vectors.length} cases`);
