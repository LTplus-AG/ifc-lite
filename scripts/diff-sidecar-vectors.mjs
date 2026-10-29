/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync,writeFileSync} from 'node:fs';
import { loadDiffOracle } from './lib/diff-oracle.mjs';
const {createIdentityMapSidecar,serializeIdentityMapSidecar,createLineageSidecar,serializeLineageSidecar,parseIdentityMapSidecar,parseLineageSidecar,validateIdentityMapSidecar,validateLineageSidecar} = await loadDiffOracle();
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

// #8042 / #8071: outer fixture strings contain wire JSON, so serde can read
// the oracle without first decoding the lone surrogates being tested.
const parseVectors=[];
for(const kind of ['identity','lineage']) {
 const parse=kind==='identity'?parseIdentityMapSidecar:parseLineageSidecar;
 const serialize=kind==='identity'?serializeIdentityMapSidecar:serializeLineageSidecar;
 const add=(name,text)=>{
  const vector={kind,name,text};
  let value;
  try { value=JSON.parse(text); }
  catch(error) { if(!(error instanceof SyntaxError))throw error; vector.invalid=true; parseVectors.push(vector); return; }
  const validate=kind==='identity'?validateIdentityMapSidecar:validateLineageSidecar;
  vector.errorsWire=JSON.stringify(validate(value),null,2)+'\n';
  const create=kind==='identity'?createIdentityMapSidecar:createLineageSidecar;
  try { vector.createWire=serialize(create(value)); }
  catch(error) { if(!(error instanceof Error))throw error; vector.createErrorJson=JSON.stringify(error.message); }
  try { vector.wire=serialize(parse(text)); }
  catch(error) { if(!(error instanceof Error))throw error; vector.invalid=true; }
  parseVectors.push(vector);
 };
 const document={format:kind==='identity'?'ifc-lite/identity-map':'ifc-lite/lineage',version:1,
  base:{hash:'a'},head:{hash:'b'},entries:[],...(kind==='lineage'?{deleted:[]}: {})};
 for(const [name,units] of [['high',[0xd800]],['low',[0xdc00]],['two-high',[0xd800,0xd800]],
  ['two-low',[0xdc00,0xdc00]],['pair',[0xd800,0xdc00]],['separated',[0xd800,65,0xdc00]],
  ['replacement',[0xfffd]],['literal-escape',[92,117,100,56,48,48]],['controls',[0,8,9,10,12,13,34,92]],
  ['astral',[0xd83d,0xde00]]]) {
  const value=String.fromCharCode(...units);
  const entries=kind==='identity'?[{base:value,here:'head',reason:value}]:[{base:[value],head:['head'],relation:'identity',reason:value}];
  add(name,JSON.stringify({...document,version:2,keyProperty:value,base:{hash:value,path:value},
   head:{hash:'b',path:value},entries,extra:{[value]:value,'20':'twenty','2':'two','01':'leading zero'}}));
 }
 // Duplicate names use decoded UTF-16 identity, preserving first position and
 // last value. A real replacement character remains a separate property.
 add('duplicate-surrogate-keys',JSON.stringify(document).slice(0,-1)+String.raw`,"extra":{"\ud800":1,"�":2,"\uD800":3,"2":"two","20":"twenty","😀":4,"\ud83d\ude00":5}}`);
 const a=String.fromCharCode(0xd800), b=String.fromCharCode(0xfffd);
 if(kind==='identity') {
  add('distinct-surrogate-identities',JSON.stringify({...document,entries:[{base:a,here:a,reason:a},{base:b,here:b,reason:b}]}));
  add('conflicting-surrogate-identities',JSON.stringify({...document,entries:[{base:'x',here:a,reason:''},{base:'y',here:a,reason:''}]}));
 } else {
  const entry=base=>({base:[base],head:[base+'head'],relation:'identity',reason:''});
  add('distinct-surrogate-identities',JSON.stringify({...document,entries:[entry(a),entry(b)],deleted:[a+'deleted',b+'deleted']}));
  add('repeated-surrogate-identities',JSON.stringify({...document,entries:[entry(a),entry(a)]}));
  add('surrogate-deleted-overlap',JSON.stringify({...document,entries:[entry(a)],deleted:[a]}));
 }
 for(const extra of ['null','true','false','0','-0','1.25e+3','1e400','-1e400',
  '[]','{}','[1,true,null,{"x":"😀"}]']) {
  add('extra-'+extra,JSON.stringify(document).slice(0,-1)+',"extra":'+extra+'}');
 }
 for(const invalid of ['{','[1,]','{"x":1,}','{"x":01}','{"x":.1}','{"x":1.}',
  '{"x":+1}','{"x":1e}','{"x":NaN}','{"x":"\\uXYZ0"}','{"x":"\\u123"}',
  '{"x":"\\q"}','{"x":"unescaped\nline"}','true false','\u00a0{}','{"x":undefined}']) add('syntax-'+invalid,invalid);
}
const parsePath=new URL('../rust/diff/tests/sidecar_parse_vectors.json',import.meta.url);
const parseText='[\n'+parseVectors.map(v=>JSON.stringify(v)).join(',\n')+'\n]\n';
if(process.argv.includes('--check')) {if(readFileSync(parsePath,'utf8')!==parseText)throw new Error('Sidecar parse corpus differs from TypeScript');}
else writeFileSync(parsePath,parseText);
console.log('Sidecar parse parity: '+parseVectors.length+' cases');
