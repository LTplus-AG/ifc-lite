/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync } from 'node:fs';
import { diffModels, lineageOfDiff, lineageConflicts, keyAliasesFromLineage, rekeyByLineage,
 identityMapFromContentMatches, identityMapFromSuccessors } from '../packages/diff/dist/index.js';
const cases=JSON.parse(readFileSync(new URL('../rust/diff/tests/successor_vectors.json',import.meta.url),'utf8'))
 .filter(v=>!v.name.startsWith('budget-')).map(({expected,...v})=>v);
const e=(key)=>({key,ref:key,ifcType:'IfcWall',dataHash:'same'});
for(const [reason,relation] of [['successor:position',undefined],['manual',undefined],['successor:position','identity'],['manual','replaced']]) {
 cases.push({name:`alias-${reason}-${relation}`,base:[e('a')],head:[e('b')],options:{keyAliases:[['b','a']]},
  aliasReasons:[['b',reason]],...(relation?{aliasRelations:[['b',relation]]}:{})});
}
const vectors=[];
for(const input of cases) for(const accept of [false,true]) {
 const options={...input.options};
 if(options.keyAliases) options.keyAliases=new Map(options.keyAliases);
 const diff=diffModels(input.base,input.head,options);
 const lineageOptions={accepted:accept?diff.successors:undefined,
  aliasReasons:new Map(input.aliasReasons),aliasRelations:new Map(input.aliasRelations)};
 const lineage=lineageOfDiff(diff,lineageOptions);
 const keys=[...input.base.map(e=>e.key),'unmentioned'];
 vectors.push({...input,name:`${input.name}-${accept}`,accept,keys,
  expected:{...diff,byKey:[...diff.byKey],...(diff.appliedKeyAliases?{appliedKeyAliases:[...diff.appliedKeyAliases]}:{})},
  expectedLineage:{lineage,conflicts:lineageConflicts(lineage.entries),aliases:[...keyAliasesFromLineage(lineage.entries)],
   identity:identityMapFromContentMatches(diff.contentMatches),accepted:identityMapFromSuccessors(lineageOptions.accepted),
   rekey:Object.fromEntries(['copy-to-all','largest-share','orphan-on-split'].map(p=>[p,rekeyByLineage(keys,lineage,p)]))}});
}
const path=new URL('../rust/diff/tests/lineage_vectors.json',import.meta.url);
const text=`[\n${vectors.map(v=>JSON.stringify(v)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {
 if(readFileSync(path,'utf8')!==text) throw new Error('Lineage vectors differ from the built TypeScript engine');
} else writeFileSync(path,text);
console.log(`Lineage parity: ${vectors.length} cases`);
