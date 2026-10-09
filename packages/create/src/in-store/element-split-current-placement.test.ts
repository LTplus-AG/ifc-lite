/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { it,expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView,StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addSlabToStore } from './slab.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { splitElementInStore } from './element-split.js';
import { resolveSplitTarget } from './edit/split-target.js';
import { meshStairs as meshProducts,stairWasmAvailable,type StairMesh } from './__test__/stair-mesh.oracle.js';
const sample=new URL('../../../../apps/viewer/public/samples/building-architecture.ifc',import.meta.url);
const storeyGuid='1Ano2ZUxnEIvVQ_beukl8b';
async function parse(bytes:Uint8Array){return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,{disableWorkerScan:true});}
function exported(store:Awaited<ReturnType<typeof parse>>,view:MutablePropertyView){return new StepExporter(store,view).export({schema:'IFC4',applyMutations:true,timeStamp:'2026-10-09T00:00:00'}).content;}
function volume(meshes:StairMesh[]){let result=0;for(const {positions:p,indices:t} of meshes)for(let i=0;i<t.length;i+=3){const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;result+=p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]);}return Math.abs(result/6);}
for(const mode of ['named','positional'] as const)it.skipIf(!stairWasmAvailable)(`#7315 native ${mode} source slab retarget commits real cut geometry at the current origin`,async()=>{
 let store=await parse(await readFile(sample)),view=new MutablePropertyView(store.properties,'native'),editor=new StoreEditor(store,view);
 const storey=store.entities.getExpressIdByGlobalId(storeyGuid),anchor=resolveSpatialAnchor(store,storey,view),id=addSlabToStore(editor,anchor,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Actual native retarget'}).slabId;
 store=await parse(exported(store,view));view=new MutablePropertyView(store.properties,'native');editor=new StoreEditor(store,view);
 const local=Number(store.getEntity(id)?.attributes[5]),point=editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 if(mode==='named')editor.setAttribute(local,'RelativePlacement',`#${axis.expressId}`);else editor.setPositionalAttribute(local,1,`#${axis.expressId}`);
 const before=await parse(exported(store,view));expect(before.getEntity(local)?.attributes[1]).toBe(axis.expressId);
 const result=splitElementInStore(store,editor,id,{kind:'slab',a:[24,-100],b:[24,100]});
 const after=await parse(exported(store,view)),empty=new MutablePropertyView(after.properties,'saved'),afterEditor=new StoreEditor(after,empty);
 const left=resolveSplitTarget(after,empty,afterEditor,result.leftId,anchor.lengthUnitScale),right=resolveSplitTarget(after,empty,afterEditor,result.rightId,anchor.lengthUnitScale);expect(left.ok&&right.ok).toBe(true);
 if(!left.ok||left.kind!=='slab'||!right.ok||right.kind!=='slab')throw new Error('Native slab split did not preserve both readable halves');
 const vertices=[...left.chain.footprint,...right.chain.footprint];expect(Math.min(...vertices.map(p=>p[0]))).toBeCloseTo(22,8);expect(Math.max(...vertices.map(p=>p[0]))).toBeCloseTo(28,8);expect(Math.min(...vertices.map(p=>p[1]))).toBeCloseTo(21,8);expect(Math.max(...vertices.map(p=>p[1]))).toBeCloseTo(25,8);
 const originalMeshes=(await meshProducts(new TextDecoder().decode(exported(before,new MutablePropertyView(before.properties,'saved'))))).get(id);expect(originalMeshes?.length).toBeGreaterThan(0);
 const meshes=await meshProducts(new TextDecoder().decode(exported(store,view))),first=meshes.get(result.leftId),second=meshes.get(result.rightId);expect(first?.length).toBeGreaterThan(0);expect(second?.length).toBeGreaterThan(0);
 expect(volume([...(first??[]),...(second??[])])).toBeCloseTo(volume(originalMeshes??[]),5);
});
