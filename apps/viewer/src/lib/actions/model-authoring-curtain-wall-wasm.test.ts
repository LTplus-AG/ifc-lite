/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
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
  const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);const ghosts=authoringGhosts(useViewerStore.getState(),preview);assert.equal(ghosts.length,variant==='custom-section'?0:2);
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
