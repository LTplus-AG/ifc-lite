/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync,writeFileSync} from 'node:fs';
import {validateIdentityMapSidecar,validateLineageSidecar} from '../packages/diff/dist/index.js';
const vectors=[];
for(const kind of ['identity','lineage']) {
 const valid={format:`ifc-lite/${kind==='identity'?'identity-map':'lineage'}`,version:1,base:{hash:'a'},head:{hash:'b'},entries:[],...(kind==='lineage'?{deleted:[]}:{})};
 const run=(name,value)=>vectors.push({kind,name,value,errors:(kind==='identity'?validateIdentityMapSidecar:validateLineageSidecar)(value)});
 for(const value of [null,[],1,'x',{},valid])run('root',value);
 for(const key of ['format','version','base','head','entries','created','keyProperty',...(kind==='lineage'?['deleted']:[])]) {
  for(const value of [null,[],{},0,1,2,3,'','x','\uFEFF'])run(`${key}-${JSON.stringify(value)}`,{...valid,[key]:value});
 }
 for(const key of ['base','head'])for(const value of [{},{hash:''},{hash:1},{hash:'x',path:null},{hash:'x',path:'ok'}])run(`${key}-shape`,{...valid,[key]:value});
 const entry=kind==='identity'?{base:'a',here:'b',reason:'r'}:{base:['a'],head:['b'],relation:'identity',reason:'r'};
 for(const item of [null,{},[],entry,{...entry,reason:null}])run('entry',{...valid,entries:[item]});
 if(kind==='identity') {
  run('conflict',{...valid,entries:[entry,{base:'c',here:'b',reason:'other'}]});
  run('self-conflict',{...valid,entries:[{base:'b',here:'b',reason:''},entry]});
 } else {
  for(const relation of ['identity','split','merge','replaced','invalid'])for(const shares of [undefined,[],[0],[0.4,0.6],[-1],null]) {
   run(`relation-${relation}`,{...valid,entries:[{base:['a'],head:['b','c'],relation,reason:'r',...(shares===undefined?{}:{shares})}]});
  }
  run('repeated',{...valid,entries:[entry,entry],deleted:['a','a']});
 }
}
const path=new URL('../rust/diff/tests/sidecar_validation_vectors.json',import.meta.url);
const text=`[\n${vectors.map(v=>JSON.stringify(v)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==text)throw new Error('Sidecar validation corpus differs from TypeScript');}
else writeFileSync(path,text);
console.log(`Sidecar validation parity: ${vectors.length} cases`);
