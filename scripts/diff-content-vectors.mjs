/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync } from 'node:fs';
import { diffModels } from '../packages/diff/dist/index.js';

// Reuse the key-pass input combinations, then exercise the content-only tiers.
const core = JSON.parse(readFileSync(new URL('../rust/diff/tests/core_vectors.json', import.meta.url), 'utf8'));
const cases = core.map(({ expected, ...input }) => ({ ...input, name: `content-${input.name}` }));
const e = (key, dataHash, geometryHash, x, extra = {}) => ({
  key, ref: key, ifcType: 'IfcWall', dataHash,
  ...(geometryHash === undefined ? {} : { geometryHash }),
  ...(x === undefined ? {} : { aabb: { min: [x, 0, 0], max: [x + 1, 1, 1] } }), ...extra,
});
cases.push(
  { name: 'respecified-before-position', base: [e('a','d','g1',0),e('b','d','g2',3)], head:[e('c','new','g1',0),e('d','d','g3',2.5)] },
  { name: 'collision-guard', base:[e('a','d','g',0,{components:{p:'a'}})], head:[e('b','d','g',0,{components:{p:'b'}})] },
  { name: 'placement-only', base:[e('a','d','g')], head:[e('b','new','g')] },
  { name: 'geometry-hash-box-collision', base:[e('a','d','g',0)], head:[e('b','new','g',100)] },
  { name: 'respecified-components', base:[e('a','d','g',0,{components:{p:'a'}})], head:[e('b','new','g',0,{components:{p:'b',q:'c'}})] },
  { name: 'geometry-nn', base:[e('a','d1','g',0),e('b','d2','g',0)], head:[e('c','d3','g',0),e('d','d4','g',0)] },
  { name: 'data-geometry-nn', base:[e('a','d','g',0),e('b','d','g',0)], head:[e('c','d','g',0),e('d','d','g',0)] },
  { name: 'position-tie', base:[e('a','d','a',0)], head:[e('b','d','b',-1),e('c','d','c',1)] },
  { name: 'position-two', base:[e('a','d','a',0),e('b','d','b',5)], head:[e('c','d','c',1),e('d','d','d',4)] },
  { name: 'position-veto', base:[e('a','d','a',0,{components:{p:'a'}}),e('b','d','b',5)], head:[e('c','d','c',1,{components:{p:'b'}}),e('d','d','d',4)] },
  { name: 'empty-components', base:[e('a','d','a',0,{components:{}})], head:[e('b','d','b',0,{components:{}})] },
  { name: 'geometry-groups-pruned', base:[e('a','d1','g',0),e('b','d2','g',0)], head:[e('c','d1','g',0),e('d','d3','g',0)] },
);
for (const shift of [0, 0.001, 0.002, 0.003, 10, 11]) cases.push({
  name: `movement-${shift}`, base:[e('a','d','a',0)], head:[e('b','d','b',shift)],
});
for (const size of [128,129]) cases.push({ name:`position-budget-${size}`,
  base:Array.from({length:size},(_,i)=>e(`a${i}`,'d',`a${i}`,i*3)),
  head:Array.from({length:size},(_,i)=>e(`b${i}`,'d',`b${i}`,i*3+0.1)),
});
const vectors=cases.map(input=>{
  const options={...input.options,matchUnpairedByContent:true};
  const callOptions={...options};
  if(callOptions.keyAliases!==undefined) callOptions.keyAliases=new Map(callOptions.keyAliases);
  const result=diffModels(input.base,input.head,callOptions);
  return {...input,options,expected:{...result,byKey:[...result.byKey],
    ...(result.appliedKeyAliases===undefined?{}:{appliedKeyAliases:[...result.appliedKeyAliases]})}};
});
const path=new URL('../rust/diff/tests/content_vectors.json',import.meta.url);
const text=`[\n${vectors.map(vector=>JSON.stringify(vector)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {
  if(readFileSync(path,'utf8')!==text) throw new Error('Content vectors differ from the built TypeScript engine');
} else writeFileSync(path,text);
console.log(`Content parity: ${vectors.length} cases`);
