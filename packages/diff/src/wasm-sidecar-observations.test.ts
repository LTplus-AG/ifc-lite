/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as identityOracle from '../test/oracle/identity-sidecar.js';
import * as lineageOracle from '../test/oracle/lineage-sidecar.js';
import type { IdentityMapSidecar, IdentityMapSidecarInit } from './identity-sidecar.js';
import type { LineageSidecar, LineageSidecarInit } from './lineage-sidecar.js';
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const wasmTest = test.skipIf(!existsSync(binary) || !existsSync(new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url)));
async function adapters() {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({module:readFileSync(binary)});
  return {identity:await import('./wasm-identity-sidecar.js'),lineage:await import('./wasm-lineage-sidecar.js')};
}
const init = {base:{hash:'old',path:'before'},head:{hash:'new'},entries:[{base:'b',here:'h',reason:''}]};
const lineageInit: LineageSidecarInit = {base:init.base,head:init.head,entries:[{base:['b'],head:['h'],relation:'identity',reason:''}],deleted:['gone']};
/** Compare actual access traces, rather than asserting source text or guessing
 * the evaluation count of an expression containing throwing/changing getters. */
function observed(value: object, log: string[], path = 'root'): object {
  const cache = new WeakMap<object,object>();
  function wrap(target: object, label: string): object {
    const cached = cache.get(target); if (cached) return cached;
    const proxy = new Proxy(target,{ get(object,key,receiver) {
      log.push(`${label}.${String(key)}`);
      const result: unknown = Reflect.get(object,key,receiver);
      return result !== null && typeof result === 'object' ? wrap(result,`${label}.${String(key)}`) : result;
    }, has(object,key) { log.push(`${label}.has(${String(key)})`); return Reflect.has(object,key); } });
    cache.set(target,proxy); return proxy;
  }
  return wrap(value,path);
}
function result(run: () => unknown): unknown {
  try { return {value:run()}; } catch(error) {
    return error instanceof Error ? {error:error.name,message:error.message} : {thrown:error};
  }
}
wasmTest('Rust validators perform exactly the oracle getter sequence and stop at the first malformed entry (#8042)',async()=>{
  const {identity,lineage}=await adapters();
  const cases: [object,(v:unknown)=>string[],(v:unknown)=>string[]][] = [
    [identityOracle.createIdentityMapSidecar(init),identity.validateIdentityMapSidecar,identityOracle.validateIdentityMapSidecar],
    [{...identityOracle.createIdentityMapSidecar(init),entries:[{base:1},new Proxy({},{get(){throw new Error('must stop first');}})]},identity.validateIdentityMapSidecar,identityOracle.validateIdentityMapSidecar],
    [lineageOracle.createLineageSidecar(lineageInit),lineage.validateLineageSidecar,lineageOracle.validateLineageSidecar],
    [{...lineageOracle.createLineageSidecar(lineageInit),entries:[{base:['b'],head:['h'],relation:'split',reason:'',shares:[1]}]},lineage.validateLineageSidecar,lineageOracle.validateLineageSidecar],
    [{...lineageOracle.createLineageSidecar(lineageInit),entries:[{base:['b'],head:['h'],relation:'bad'},null],deleted:['b']},lineage.validateLineageSidecar,lineageOracle.validateLineageSidecar],
  ];
  for(const [input,validate,oracle] of cases){
    const expectedLog:string[]=[];const actualLog:string[]=[];
    const expected=result(()=>oracle(observed(input,expectedLog)));
    const actual=result(()=>validate(observed(input,actualLog)));
    expect(actual).toEqual(expected);
    expect(actualLog).toEqual(expectedLog);
  }
});
wasmTest('create, mismatches and aliases retain getter/coercion order through actual WASM (#8042)',async()=>{
  const {identity,lineage}=await adapters();
  const operations:[object,(value:object)=>unknown,(value:object)=>unknown][]=[
    [init,v=>identity.createIdentityMapSidecar(v as IdentityMapSidecarInit),v=>identityOracle.createIdentityMapSidecar(v as IdentityMapSidecarInit)],
    [lineageInit,v=>lineage.createLineageSidecar(v as LineageSidecarInit),v=>lineageOracle.createLineageSidecar(v as LineageSidecarInit)],
    [identityOracle.createIdentityMapSidecar(init),v=>[...identity.keyAliasesFromSidecar(v as IdentityMapSidecar)],v=>[...identityOracle.keyAliasesFromSidecar(v as IdentityMapSidecar)]],
    [identityOracle.createIdentityMapSidecar(init),v=>identity.identityMapSidecarMismatches(v as IdentityMapSidecar,{base:{hash:'x'},head:{hash:'y'},keyProperty:'Tag'}),v=>identityOracle.identityMapSidecarMismatches(v as IdentityMapSidecar,{base:{hash:'x'},head:{hash:'y'},keyProperty:'Tag'})],
    [lineageOracle.createLineageSidecar(lineageInit),v=>lineage.lineageSidecarMismatches(v as LineageSidecar,{base:{hash:'x'},head:{hash:'y'}}),v=>lineageOracle.lineageSidecarMismatches(v as LineageSidecar,{base:{hash:'x'},head:{hash:'y'}})],
  ];
  for(const[input,run,oracle]of operations){
    const expectedLog:string[]=[];const actualLog:string[]=[];
    expect(result(()=>run(observed(input,actualLog)))).toEqual(result(()=>oracle(observed(input,expectedLog))));
    expect(actualLog).toEqual(expectedLog);
  }
});
wasmTest('throwing getters preserve the original exception object; custom every and iterator close stay observable (#8042)',async()=>{
  const {identity,lineage}=await adapters();
  const sentinel=new RangeError('getter sentinel \ud800');
  const valid=identityOracle.createIdentityMapSidecar(init);
  for(const validate of [identity.validateIdentityMapSidecar,identityOracle.validateIdentityMapSidecar]){
    const input={...valid,get format(){throw sentinel;}};
    try{validate(input);expect.unreachable('getter must throw');}catch(error){expect(error).toBe(sentinel);}
  }
  function custom(log:string[]){
    const entries:unknown[]=[];
    Object.defineProperty(entries,Symbol.iterator,{value:function*(){try{log.push('yield malformed');yield {base:1};log.push('must not resume');}finally{log.push('closed');}}});
    return {...valid,entries};
  }
  const expectedLog:string[]=[];const actualLog:string[]=[];
  expect(identity.validateIdentityMapSidecar(custom(actualLog))).toEqual(identityOracle.validateIdentityMapSidecar(custom(expectedLog)));
  expect(actualLog).toEqual(expectedLog);expect(actualLog).toEqual(['yield malformed','closed']);
  function customEvery(log:string[]){
    const base=['b'];Object.defineProperty(base,'every',{value:(predicate:(value:unknown,index:number,list:string[])=>unknown)=>{log.push('every override');return predicate('accepted',0,base);}});
    return {...lineageOracle.createLineageSidecar(lineageInit),entries:[{base,head:['h'],relation:'identity',reason:''}]};
  }
  const a:string[]=[];const b:string[]=[];
  expect(lineage.validateLineageSidecar(customEvery(a))).toEqual(lineageOracle.validateLineageSidecar(customEvery(b)));
  expect(a).toEqual(b);expect(a).toEqual(['every override']);
});
wasmTest('changing getters expose repeat reads and inherited sparse indices (#8042)',async()=>{
  const {identity,lineage}=await adapters();
  function changing(){
    let count=0;
    return {...identityOracle.createIdentityMapSidecar(init),get version(){return ++count===1?1:2;},get keyProperty(){return count>2?'Tag':undefined;}};
  }
  expect(result(()=>identity.validateIdentityMapSidecar(changing()))).toEqual(result(()=>identityOracle.validateIdentityMapSidecar(changing())));
  const prototype=Object.create(Array.prototype) as string[];prototype[0]='inherited';
  const sparse=new Array<string>(1);Object.setPrototypeOf(sparse,prototype);
  const input={...lineageOracle.createLineageSidecar(lineageInit),entries:[{base:sparse,head:['h'],relation:'identity',reason:''}]};
  expect(lineage.validateLineageSidecar(input)).toEqual(lineageOracle.validateLineageSidecar(input));
  expect(lineage.validateLineageSidecar(input)).toEqual([]);
});
wasmTest('custom array methods may retain Rust predicates and return their own sorted iterable (#8042)',async()=>{
  const {lineage}=await adapters();
  function input(){
    let stringPredicate:((value:unknown)=>boolean)|undefined;
    let filterPredicate:((value:unknown)=>boolean)|undefined;
    let comparator:((a:unknown,b:unknown)=>number)|undefined;
    const base=['b'];
    Object.defineProperty(base,'every',{value:(callback:(value:unknown)=>boolean)=>{stringPredicate=callback;return true;}});
    const deleted=['gone'];
    Object.defineProperty(deleted,'filter',{value:(callback:(value:unknown)=>boolean)=>{
      filterPredicate=callback;
      return {sort(compare:(a:unknown,b:unknown)=>number){comparator=compare;return ['custom-return'];}};
    }});
    return {value:{...lineageOracle.createLineageSidecar(lineageInit),entries:[{base,head:['h'],relation:'identity',reason:''}],deleted}, retained(){
      return [stringPredicate?.('ok'),stringPredicate?.(''),stringPredicate?.(Symbol()),filterPredicate?.('b'),filterPredicate?.('gone'),comparator?.('z','a'),comparator?.('\ud800','\ue000')];
    }};
  }
  const actual=input();const expected=input();
  expect(lineage.validateLineageSidecar(actual.value)).toEqual(lineageOracle.validateLineageSidecar(expected.value));
  expect(actual.retained()).toEqual(expected.retained());
  expect(actual.retained()).toEqual([true,false,false,true,false,1,-1]);
});
wasmTest('a retained sort comparator can be reentered by host primitive conversion (#8042)',async()=>{
  const {lineage}=await adapters();
  function input(log:number[]){
    const deleted=['gone'];
    Object.defineProperty(deleted,'filter',{value:()=>({sort(compare:(a:unknown,b:unknown)=>number){
      const left={[Symbol.toPrimitive](){log.push(compare('x','y'));return 'b';}};
      log.push(compare(left,'a'));
      return [];
    }})});
    return {...lineageOracle.createLineageSidecar(lineageInit),deleted};
  }
  const a:number[]=[];const b:number[]=[];
  expect(lineage.validateLineageSidecar(input(a))).toEqual(lineageOracle.validateLineageSidecar(input(b)));
  expect(a).toEqual(b);expect(a).toEqual([-1,-1,1]);
});
