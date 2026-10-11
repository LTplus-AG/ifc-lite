/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { ProfileSection } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, GROUND_STOREY, SAMPLE_MODEL, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { authoringReachEvidence } from './model-authoring-reach';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { authoringGhosts } from './model-authoring-ghost';
import { commitModelAuthoring } from './model-authoring-commit';

const original=useViewerStore.getState();afterEach(()=>useViewerStore.setState(original));
const wasm=new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm',import.meta.url);
const volume=(mesh:Pick<MeshData,'positions'|'indices'>)=>{
  const p=mesh.positions,ids=mesh.indices;let sum=0;
  for(let i=0;i<ids.length;i+=3){const a=ids[i]*3,b=ids[i+1]*3,c=ids[i+2]*3;sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}
  return Math.abs(sum);
};

test('#7262 native WASM proves sloped rectangle/hollow reach ghosts and the stated rounded-profile approximation',{skip:!existsSync(wasm)&&'run pnpm build:wasm:fetch'},async()=>{
  const {dataStore,view}=await seedAuthoringSample(),state=useViewerStore.getState,storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const cases:Array<{kind:'beam'|'member';Profile:ProfileSection}>=[{kind:'beam',Profile:{Type:'Rectangle',XDim:.4,YDim:.3}},{kind:'member',Profile:{Type:'RectangleHollow' as const,XDim:.4,YDim:.3,WallThickness:.02}},
    {kind:'beam',Profile:{Type:'I' as const,OverallWidth:.2,OverallDepth:.4,WebThickness:.01,FlangeThickness:.03,FilletRadius:.025}}];
  const operations=cases.map((spec,i)=>{
    const y=20+i*4,params={Start:[0,y,3] as [number,number,number],End:[8,y,5] as [number,number,number],Name:`Native reach ${i}`,...spec};
    const result=spec.kind==='member'?state().addMember(SAMPLE_MODEL,storey,params):state().addBeam(SAMPLE_MODEL,storey,params);
    assert.ok('expressId' in result,'error' in result?result.error:'');
    const entity=view.getNewEntity(result.expressId);assert.ok(entity&&typeof entity.attributes[0]==='string');
    return {op:'element.trimExtend',mode:'extend',target:{globalId:entity.attributes[0],name:params.Name,ifcClass:spec.kind==='member'?'IfcMember':'IfcBeam'},
      expected:authoringReachEvidence(state(),SAMPLE_MODEL,result.expressId),click:[8,y],boundary:{line:{a:[10,y-5],b:[10,y+5],tMin:0,tMax:1,reach:0}}};
  });
  const proposed=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native reach geometry',units:'m',frame:'storey-local',operations}));
  const before=view.getMutationCount(),preview=previewModelAuthoring(state(),proposed);assert.deepEqual(preview.rows.map(r=>[r.status,r.issue]),cases.map(()=>['ready',undefined]));
  const ghosts=authoringGhosts(state(),preview);assert.equal(ghosts.length,3);assert.equal(view.getMutationCount(),before);
  assert.deepEqual(preview.rows[2].previewOmitted,['FilletRadius'],'positive rounding is explicitly omitted by the canonical section preview');
  const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0,1,2]),'native WASM reach');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
  const bytes=editedModelBytes(dataStore,view),parsed=await parseIfc(bytes),ids=outcome.receipt.applied.map(r=>parsed.entities.getExpressIdByGlobalId(r.globalId));
  initSync({module:readFileSync(wasm)});const api=new IfcAPI(),solid=new Map<number,{volume:number;min:number[];max:number[]}>();
  try{
    const pre=api.buildPrePassOnce(bytes),[x,y,z]=pre.rtcOffset?Array.from(pre.rtcOffset as ArrayLike<number>):[0,0,0];
    const collection=api.processGeometryBatch(bytes,pre.jobs,pre.unitScale,x,y,z,pre.needsShift,pre.voidKeys,pre.voidCounts,pre.voidValues,pre.styleIds,pre.styleColors);
    try{for(let i=0;i<collection.length;i++){const mesh=collection.get(i);if(!mesh)continue;try{if(!ids.includes(mesh.expressId))continue;
      const positions=mesh.positions,box=solid.get(mesh.expressId)??{volume:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]},origin=mesh.origin;
      box.volume+=volume({positions,indices:mesh.indices});for(let at=0;at<positions.length;at+=3)for(let axis=0;axis<3;axis++){const v=positions[at+axis]+origin[axis];box.min[axis]=Math.min(box.min[axis],v);box.max[axis]=Math.max(box.max[axis],v);}solid.set(mesh.expressId,box);
    }finally{mesh.free();}}}finally{collection.free();}
  }finally{api.clearPrePassCache();api.free();}
  for(const [i,id]of ids.entries()){
    const native=solid.get(id);assert.ok(native&&native.volume>0);const ghost=ghosts[i];assert.ok(volume(ghost)>0);
    for(let axis=0;axis<3;axis++){const coordinates=Array.from(ghost.positions).filter((_v,at)=>at%3===axis);assert.ok(Math.abs(Math.min(...coordinates)-native.min[axis])<.001&&Math.abs(Math.max(...coordinates)-native.max[axis])<.001,`native sloped frame bounds ${i}/${axis}`);}
    if(i===2)assert.ok(native.volume>volume(ghost)*1.02&&native.volume<volume(ghost)*1.05,'native fillet survives export and differs from disclosed sharp corners');
    else assert.ok(Math.abs(native.volume-volume(ghost))/native.volume<.002,`native hollow/rectangular volume ${i} is not a flat solid bounding prism`);
  }
});
