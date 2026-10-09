/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { readStairDimensions } from '@ifc-lite/create';
import { buildStoreyWorkplane,isWorkplane } from '@/lib/commands/modeling/workplane';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { seedAuthoringSample,GROUND_STOREY,SAMPLE_MODEL,parseIfc } from '@/test/authoring-sample-fixture';
import { meshStairs,stairMeshBounds,stairWasmAvailable,type StairMesh } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';
const original=useViewerStore.getState();afterEach(()=>useViewerStore.setState(original));
function volume(mesh:Pick<StairMesh,'positions'|'indices'>){let sum=0;const p=mesh.positions,k=mesh.indices;for(let i=0;i<k.length;i+=3){const a=k[i]*3,b=k[i+1]*3,c=k[i+2]*3;sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}return Math.abs(sum);}
for(const waist of [undefined,.1])test(`#7273 actual native WASM stair body and sloped railing after reviewed commit, waist=${waist}`,{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const {dataStore,view}=await seedAuthoringSample(),get=useViewerStore.getState;
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native bodies',frame:'storey-local',units:'m',operations:[
  {op:'stair.create',ref:'stair',storey:{globalId:GROUND_STOREY},params:{Position:[1,2,0],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,...(waist===undefined?{}:{WaistThickness:waist})}},
  {op:'railing.create',ref:'rail',storey:{globalId:GROUND_STOREY},params:{Path:[[1,4,0],[3,4,.4],[3,6,.4]],Height:1.1,PostSpacing:.8}},
 ]}));
 const frame=buildStoreyWorkplane(get(),SAMPLE_MODEL,dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),0);assert.ok(isWorkplane(frame));for(const [axis,value] of [3,0,-3].entries())assert.ok(Math.abs(frame.localToRender([0,0,0])[axis]-value)<1e-9,'Committed SketchUp ground storey is translated by (3,3) metres');
 const before=view.getMutations(),preview=previewModelAuthoring(get(),batch);assert.deepEqual(preview.rows.map(r=>r.status),['ready','ready']);const ghosts=authoringGhosts(get(),preview);assert.equal(ghosts.length,2,'Existing command previews are reused rather than inventing a geometry path');assert.deepEqual(view.getMutations(),before);
 const outcome=commitModelAuthoring(useViewerStore,preview,new Set([0,1]),'real native body invariant');assert.ok(outcome.ok,outcome.ok?'':outcome.detail??outcome.reason);
 const bytes=editedModelBytes(dataStore,view),parsed=await parseIfc(bytes),stairId=parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId),railId=parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[1].globalId),dimensions=readStairDimensions(parsed,stairId);assert.ok(dimensions);
 const native=await meshStairs(new TextDecoder().decode(bytes)),flight=native.get(dimensions.flightId),rail=native.get(railId);assert.ok(flight?.length&&rail?.length,'Real native stair flight and railing have mesh bodies');
 const bounds=stairMeshBounds(flight);for(const [i,v]of [4,5,0].entries())assert.ok(Math.abs(bounds.min[i]-v)<.001,`bounds ${JSON.stringify(bounds)}, axis ${i}, expected min ${v}`);for(const [i,v]of [5.2,6,.8].entries())assert.ok(Math.abs(bounds.max[i]-v)<.001,`bounds ${JSON.stringify(bounds)}, axis ${i}, expected max ${v}`);
 const actual=flight.reduce((sum,m)=>sum+volume(m),0),solid=.2*.3*4*5/2,drop=waist===undefined?0:waist*Math.hypot(.2,.3)/.3,foot=drop*.3/.2,expected=waist===undefined?solid:solid-(1.2-foot)*(.8-drop)/2;assert.ok(Math.abs(actual-expected)<.001,'Independent stepped prism volume subtracts the pitch-line underside triangle');
 const ghostVolume=volume({positions:Array.from(ghosts[0].positions),indices:Array.from(ghosts[0].indices)});assert.ok(Math.abs(ghostVolume-solid)<.001,'Canonical command ghost is exactly the disclosed solid-step body');if(waist!==undefined)assert.ok(ghostVolume>actual*2,'Native waist underside differs from the disclosed solid preview');
 const nativeRenderBounds={min:[bounds.min[0],bounds.min[2],-bounds.max[1]],max:[bounds.max[0],bounds.max[2],-bounds.min[1]]};for(let axis=0;axis<3;axis++){const positions=Array.from(ghosts[0].positions).filter((_value,i)=>i%3===axis);assert.ok(Math.abs(Math.min(...positions)-nativeRenderBounds.min[axis])<.001);assert.ok(Math.abs(Math.max(...positions)-nativeRenderBounds.max[axis])<.001);}
 const railBounds=stairMeshBounds(rail);assert.ok(Math.abs(railBounds.min[2])<.001);assert.ok(Math.abs(railBounds.max[2]-1.5)<.002);assert.ok(rail.reduce((sum,m)=>sum+volume(m),0)>0,'Sloped native swept handrail/posts have positive volume');
});

test('#7273 real WASM rotated/elevated stair agrees with canonical ghost and nondefault railing previews remain unavailable',{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const {dataStore,view}=await seedAuthoringSample(),get=useViewerStore.getState;
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native preview boundaries',units:'m',frame:'storey-local',operations:[
  {op:'stair.create',ref:'turned',storey:{globalId:GROUND_STOREY},params:{Position:[1,2,2],Direction:Math.PI/2,NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1}},
  {op:'railing.create',ref:'custom',storey:{globalId:GROUND_STOREY},params:{Path:[[1,4,0],[3,4,1]],Height:1.1,RailDiameter:.08,PostDiameter:.06}},
  {op:'railing.create',ref:'vertical',storey:{globalId:GROUND_STOREY},params:{Path:[[4,4,0],[4,4,1]],Height:1.1}},
 ]}));
 const preview=previewModelAuthoring(get(),batch);assert.deepEqual(preview.rows.map(row=>row.status),['ready','ready','ready']);assert.deepEqual(preview.rows.map(row=>row.previewUnavailable),[false,true,true]);const ghosts=authoringGhosts(get(),preview);assert.equal(ghosts.length,1,'Custom native sections and vertical rails are not silently rendered as a different ghost');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0,1,2]),'rotated native geometry');assert.ok(result.ok,result.ok?'':result.detail??result.reason);const bytes=editedModelBytes(dataStore,view),parsed=await parseIfc(bytes),root=parsed.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),dims=readStairDimensions(parsed,root);assert.ok(dims);const native=await meshStairs(new TextDecoder().decode(bytes)),flight=native.get(dims.flightId);assert.ok(flight?.length);const bounds=stairMeshBounds(flight);
 for(const [axis,value] of [3,5,2].entries())assert.ok(Math.abs(bounds.min[axis]-value)<.001);for(const [axis,value] of [4,6.2,2.8].entries())assert.ok(Math.abs(bounds.max[axis]-value)<.001);
 const renderBounds={min:[bounds.min[0],bounds.min[2],-bounds.max[1]],max:[bounds.max[0],bounds.max[2],-bounds.min[1]]};for(let axis=0;axis<3;axis++){const coordinates=Array.from(ghosts[0].positions).filter((_value,index)=>index%3===axis);assert.ok(Math.abs(Math.min(...coordinates)-renderBounds.min[axis])<.001);assert.ok(Math.abs(Math.max(...coordinates)-renderBounds.max[axis])<.001);}
 for(const applied of result.receipt.applied.slice(1)){const id=parsed.entities.getExpressIdByGlobalId(applied.globalId),meshes=native.get(id);assert.ok(meshes?.length);assert.ok(meshes.reduce((sum,mesh)=>sum+volume(mesh),0)>0,'Unavailable preview retains real native exported geometry');}
});
