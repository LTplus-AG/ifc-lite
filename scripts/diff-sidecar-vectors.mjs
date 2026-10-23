/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createIdentityMapSidecar,serializeIdentityMapSidecar,createLineageSidecar,serializeLineageSidecar} from '../packages/diff/dist/index.js';
const vectors=[];
for(const keyProperty of [undefined,'Tag','Pset_Asset.AssetId']) for(const created of [undefined,'2026-10-23T06:00:00.000Z']) {
 const common={base:{hash:'sha256:old',path:'old/𐀀.ifc'},head:{hash:'sha256:new',path:'new/.ifc'},
  ...(keyProperty===undefined?{}:{keyProperty}),...(created===undefined?{}:{created})};
 const identity=createIdentityMapSidecar({...common,entries:[{base:'z',here:'y',reason:'manual\nreview'},
  {base:'𐀀',here:'',reason:'content-match:renamed'},{base:'z',here:'y',reason:'ignored duplicate'}]});
 vectors.push({kind:'identity',value:identity,wire:serializeIdentityMapSidecar(identity)});
 for(const shares of [undefined,[1/3,2/3],[1e-7,1e21],[0,1]]) {
 const lineage=createLineageSidecar({...common,entries:[{base:['old'],head:['a','b'],relation:'split',reason:'split:verified',...(shares?{shares}:{})}],deleted:['lost','lost','𐀀','']});
 vectors.push({kind:'lineage',value:lineage,wire:serializeLineageSidecar(lineage)});
 }
}
const path=new URL('../rust/diff/tests/sidecar_vectors.json',import.meta.url);
const text=`[\n${vectors.map(v=>JSON.stringify(v)).join(',\n')}\n]\n`;
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==text)throw new Error('Sidecar wire corpus differs from TypeScript');}
else writeFileSync(path,text);
console.log(`Sidecar wire parity: ${vectors.length} cases`);
