/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { fixtureModels } from '@/test/store-fixture';
import { RelationshipType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { meshStairs, stairMeshBounds, stairWasmAvailable, type StairMesh } from '../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';
const original=useViewerStore.getState();afterEach(()=>useViewerStore.setState(original));
function volume(mesh:Pick<StairMesh,'positions'|'indices'>){const p=mesh.positions,k=mesh.indices;let sum=0;for(let i=0;i<k.length;i+=3){const a=k[i]*3,b=k[i+1]*3,c=k[i+2]*3;sum+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;}return Math.abs(sum);}
for(const variant of ['default','rotated-open','custom-section'] as const)test(`#7298 real native WASM ${variant} every aggregate part meshes; supported command ghost agrees in volume and world bounds`,{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
  const {dataStore,view}=await seedAuthoringSample();
  const params={Start:[1,2,2],End:variant==='rotated-open'?[1,6,2]:[5,2,2],Height:3,UGrid:[1,3],VGrid:[1],Name:'Native curtain body',
    ...(variant==='rotated-open'?{EdgeMembers:false}:{}),...(variant==='custom-section'?{MullionProfile:{Type:'Circle',Radius:.04},TransomProfile:{Type:'Rectangle',XDim:.06,YDim:.12},PanelThickness:.032}:{})};
  const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native curtain geometry',units:'m',frame:'storey-local',operations:[{op:'curtainWall.create',ref:'body',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params}]}));
  const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');const ghosts=authoringGhosts(useViewerStore.getState(),preview);assert.equal(ghosts.length,variant==='custom-section'?0:2);
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native WASM curtain');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
  const bytes=editedModelBytes(dataStore,view),parsed=await parseIfc(bytes),root=parsed.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),children=parsed.relationships.getRelated(root,RelationshipType.Aggregates,'forward');assert.ok(children.length>0);
  const meshes=await meshStairs(new TextDecoder().decode(bytes)),native:StairMesh[]=[];
  for(const child of children){const parts=meshes.get(child);assert.ok(parts?.length,`Every owned native ${parsed.entities.getTypeName(child)} #${child} has geometry`);assert.ok(parts.reduce((sum,part)=>sum+volume(part),0)>0);native.push(...parts);}
  if(variant==='custom-section'){assert.equal(preview.rows[0].previewUnavailable,true,'Native circular/different sections are explicitly undrawn rather than fabricated');return;}
  const bounds=stairMeshBounds(native),render={min:[bounds.min[0],bounds.min[2],-bounds.max[1]],max:[bounds.max[0],bounds.max[2],-bounds.min[1]]};
  const nativeVolume=native.reduce((sum,mesh)=>sum+volume(mesh),0),ghostVolume=ghosts.reduce((sum,mesh)=>sum+volume({positions:Array.from(mesh.positions),indices:Array.from(mesh.indices)}),0);
  assert.ok(Math.abs(nativeVolume-ghostVolume)/nativeVolume<.002,`Actual native volume ${nativeVolume} matches actual command preview ${ghostVolume}`);
  for(let axis=0;axis<3;axis++){const coordinates=ghosts.flatMap(mesh=>Array.from(mesh.positions).filter((_v,i)=>i%3===axis));assert.ok(Math.abs(Math.min(...coordinates)-render.min[axis])<.001);assert.ok(Math.abs(Math.max(...coordinates)-render.max[axis])<.001);}
});

for(const frameKind of ['live','live-xy','live-named','saved','saved-2D'] as const)test(`#7298 actual public ${frameKind} storey placement frame matches native curtain geometry or explicitly unavailable preview`,{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
  const saved=frameKind==='saved'||frameKind==='saved-2D',twoD=frameKind==='saved-2D',xy=frameKind==='live-xy'||frameKind==='live-named',zValue=xy||twoD?0:5000;
  await seedAuthoringSample();const get=useViewerStore.getState,api=createStoreAdapter(useViewerStore),source=get().models.get(SAMPLE_MODEL)!.ifcDataStore!,storey=source.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const point=api.addEntity(SAMPLE_MODEL,{type:'IfcCartesianPoint',attributes:[twoD?[15000,20000]:[15000,20000,zValue]]}),z=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[[0,0,1]]}),x=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[twoD?[0,1]:[0,1,0]]}),axis=api.addEntity(SAMPLE_MODEL,{type:twoD?'IfcAxis2Placement2D':'IfcAxis2Placement3D',attributes:twoD?[`#${point.expressId}`,`#${x.expressId}`]:[`#${point.expressId}`,`#${z.expressId}`,`#${x.expressId}`]}),placement=api.addEntity(SAMPLE_MODEL,{type:'IfcLocalPlacement',attributes:[null,`#${axis.expressId}`]});
  if(frameKind==='live-named')new StoreEditor(source,get().mutationViews.get(SAMPLE_MODEL)!).setAttribute(storey,'ObjectPlacement',`#${placement.expressId}`);else api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},5,`#${placement.expressId}`);api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},9,zValue);
  const exported=editedModelBytes(source,get().mutationViews.get(SAMPLE_MODEL)!),independent=await parseIfc(exported);assert.equal(independent.getEntity(storey)?.attributes[5],placement.expressId,'Independent native source retains the public edited storey placement');
  if(saved){const model={...get().models.get(SAMPLE_MODEL)!,ifcDataStore:independent},view=new MutablePropertyView(independent.properties,SAMPLE_MODEL);useViewerStore.setState({...fixtureModels(model),mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map()});}
  const params={Start:[1,2,0],End:[5,2,0],Height:3,UGrid:2,VGrid:2},batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native storey frame',units:'m',frame:'storey-local',operations:[{op:'curtainWall.create',ref:'frame',storey:{modelId:SAMPLE_MODEL,globalId:GROUND_STOREY},params}]}));
  const preview=previewModelAuthoring(get(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue??'');const ghosts=authoringGhosts(get(),preview);
  const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'actual native rotated storey');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
  const edited=editedModelBytes(get().models.get(SAMPLE_MODEL)!.ifcDataStore!,get().mutationViews.get(SAMPLE_MODEL)!),parsed=await parseIfc(edited),root=parsed.entities.getExpressIdByGlobalId(result.receipt.applied[0].globalId),children=parsed.relationships.getRelated(root,RelationshipType.Aggregates,'forward'),meshes=await meshStairs(new TextDecoder().decode(edited)),native:StairMesh[]=[];
  for(const child of children){const part=meshes.get(child);assert.ok(part?.length);native.push(...part);}
  if(twoD){assert.equal(ghosts.length,0,'Native 3D products under an unverified 2D parent receive no invented matching ghost');assert.equal(preview.rows[0].previewUnavailable,true);assert.ok(native.reduce((sum,mesh)=>sum+volume(mesh),0)>0,'Canonical native output is observable, without an unsupported 2D frame accuracy claim');return;}
  const bounds=stairMeshBounds(native);assert.ok(Math.abs(bounds.min[0]-12.925)<.001);assert.ok(Math.abs(bounds.min[1]-21)<.001);assert.ok(Math.abs(bounds.min[2]-zValue/1000)<.001,'Public native storey elevation and rotation are authoritative');
  if(frameKind==='live'){assert.equal(ghosts.length,0,'Changed live placement Z keeps the explicit conservative elevation/RTC preview limitation');assert.equal(preview.rows[0].previewUnavailable,true);return;}assert.equal(ghosts.length,2,'Canonical supported current XY/saved 3D storey frame must retain the actual native command preview');
  const render={min:[bounds.min[0],bounds.min[2],-bounds.max[1]],max:[bounds.max[0],bounds.max[2],-bounds.min[1]]};for(let axis=0;axis<3;axis++){const values=ghosts.flatMap(mesh=>Array.from(mesh.positions).filter((_v,i)=>i%3===axis));assert.ok(Math.abs(Math.min(...values)-render.min[axis])<.001,`Current native ${saved?'saved':'live'} storey min axis${axis}: ghost ${Math.min(...values)}, native ${render.min[axis]}`);assert.ok(Math.abs(Math.max(...values)-render.max[axis])<.001);}
});
