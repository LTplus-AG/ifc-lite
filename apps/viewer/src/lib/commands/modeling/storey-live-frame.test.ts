/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { storeyPlanFrame } from '@ifc-lite/create';
import { RelationshipType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { buildStoreyWorkplane, isWorkplane } from './workplane';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle';
const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
async function editedFrame() {
 await seedAuthoringSample(); const get=useViewerStore.getState, api=createStoreAdapter(useViewerStore), source=get().models.get(SAMPLE_MODEL)!.ifcDataStore!, storey=source.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const point=api.addEntity(SAMPLE_MODEL,{type:'IfcCartesianPoint',attributes:[[15000,20000,5000]]}), z=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[[0,0,1]]}), x=api.addEntity(SAMPLE_MODEL,{type:'IfcDirection',attributes:[[0,1,0]]}), axis=api.addEntity(SAMPLE_MODEL,{type:'IfcAxis2Placement3D',attributes:[`#${point.expressId}`,`#${z.expressId}`,`#${x.expressId}`]}), placement=api.addEntity(SAMPLE_MODEL,{type:'IfcLocalPlacement',attributes:[null,`#${axis.expressId}`]});
 api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},5,`#${placement.expressId}`);api.setPositionalAttribute({modelId:SAMPLE_MODEL,expressId:storey},9,5000);
 const view=get().mutationViews.get(SAMPLE_MODEL)!; const saved=await parseIfc(editedModelBytes(source,view));
 assert.equal(saved.getEntity(storey)?.attributes[5],placement.expressId);
 const frame=storeyPlanFrame(saved,storey);assert.ok(frame);assert.deepEqual(frame.origin,[15,20]);assert.deepEqual(frame.axisX,[0,1]);
 return {api,source,storey,view,saved,point:point.expressId,direction:x.expressId,vertical:z.expressId,placement:placement.expressId,axis:axis.expressId};
}
test('#7306 independent saved public 3D frame agrees with actual native aggregate world bounds',{skip:!stairWasmAvailable&&'run pnpm build:wasm:fetch'},async()=>{
 const {api,source,storey,view}=await editedFrame(); const made=api.addCurtainWall!(SAMPLE_MODEL,storey,{Start:[1,2,0],End:[5,2,0],Height:3,UGrid:2,VGrid:2});
 const bytes=editedModelBytes(source,view),parsed=await parseIfc(bytes),children=parsed.relationships.getRelated(made.expressId,RelationshipType.Aggregates,'forward'),meshes=await meshStairs(new TextDecoder().decode(bytes)); const native=children.flatMap(id=>meshes.get(id)??[]);assert.ok(native.length);
 const bounds=stairMeshBounds(native); assert.ok(Math.abs(bounds.min[0]-12.925)<.001);assert.ok(Math.abs(bounds.min[1]-21)<.001);assert.ok(Math.abs(bounds.min[2]-5)<.001);
});
test('#7306 current interactive/Room workplane agrees with independently saved public 3D storey frame',async()=>{
 const {storey,saved}=await editedFrame();const state=useViewerStore.getState(),live=buildStoreyWorkplane(state,SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(live));const model=state.models.get(SAMPLE_MODEL)!;
 const independent=buildStoreyWorkplane({...state,models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved}]]),mutationViews:new Map()},SAMPLE_MODEL,storey,0);assert.ok(isWorkplane(independent));
 assert.deepEqual(independent.localToRender([1,2,0]),[13,5,-21],'Saved native frame positive precondition');
 assert.deepEqual(live.localToRender([1,2,0]),independent.localToRender([1,2,0]),'Current interactive and Room workplane must not discard the effective public placement');
});

for (const edit of ['named-placement','positional-over-named','direction','deleted-point','cycle','tilted-axis','retyped-storey'] as const) test(`#7306 current ${edit} native frame agrees with independent STEP or explicitly refuses`,async()=>{
 const f=await editedFrame(),editor=new StoreEditor(f.source,f.view);
 const relocated=editor.addEntity('IfcCartesianPoint',[[25000,30000,5000]]);
 if(edit==='named-placement')editor.setAttribute(f.axis,'Location',`#${relocated.expressId}`);
 if(edit==='positional-over-named'){editor.setAttribute(f.axis,'Location',`#${relocated.expressId}`);editor.setPositionalAttribute(f.axis,0,`#${f.point}`);editor.setPositionalAttribute(f.point,0,[35000,40000,5000]);}
 if(edit==='direction')editor.setPositionalAttribute(f.direction,0,[1,0,0]);
 if(edit==='deleted-point')editor.removeEntity(f.point);
 if(edit==='cycle')editor.setAttribute(f.placement,'PlacementRelTo',`#${f.placement}`);
 if(edit==='tilted-axis')editor.setPositionalAttribute(f.vertical,0,[1,0,0]);
 if(edit==='retyped-storey')editor.setEntityType(f.storey,'IfcBuilding');
 const independentlySaved=await parseIfc(editedModelBytes(f.source,f.view));const beforeVersion=f.view.getMutationRevision();
 const plane=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);
 if(['deleted-point','cycle','tilted-axis','retyped-storey'].includes(edit)){assert.equal(isWorkplane(plane),false,`Explicit current ${edit} may not resurrect a source frame`);if(edit!=='retyped-storey')assert.equal(storeyPlanFrame(independentlySaved,f.storey),null,'Independent source proves unreadable/nonplanar frame');}
 else{assert.ok(isWorkplane(plane));const independent=storeyPlanFrame(independentlySaved,f.storey);assert.ok(independent);const [x,y]=edit==='named-placement'?[23,31]:edit==='positional-over-named'?[33,41]:[16,22];assert.deepEqual(independent.origin,edit==='direction'?[15,20]:edit==='named-placement'?[25,30]:[35,40]);assert.deepEqual(plane.localToRender([1,2,0]),[x,5,-y]);}
 assert.equal(f.view.getMutationRevision(),beforeVersion,'Current frame extraction is read-only');
});

test('#7306 identical source ids in two models retain model-local current placement',async()=>{
 const f=await editedFrame(),s=useViewerStore.getState(),model=s.models.get(SAMPLE_MODEL)!;
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,model],['other',{...model,id:'other'}]]),mutationViews:new Map([[SAMPLE_MODEL,f.view],['other',new MutablePropertyView(f.source.properties,'other')]])});
 const active=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0),other=buildStoreyWorkplane(useViewerStore.getState(),'other',f.storey,0);assert.ok(isWorkplane(active));assert.ok(isWorkplane(other));assert.deepEqual(active.localToRender([1,2,0]),[13,5,-21]);
 const legacy=other.localToRender([1,2,0]);for(let i=0;i<3;i++)assert.ok(Math.abs(legacy[i]-[4,0,-5][i])<1e-9,'Other native model retains original source frame');
});
test('#7306 over-256 live placement walk refuses and reports its bound without truncating a source frame',async()=>{
 const f=await editedFrame(),editor=new StoreEditor(f.source,f.view);let parent:number|null=null;
 for(let i=0;i<257;i++)parent=editor.addEntity('IfcLocalPlacement',[parent===null?null:`#${parent}`,`#${f.axis}`]).expressId;
 assert.ok(parent);editor.setPositionalAttribute(f.storey,5,`#${parent}`);
 const independent=await parseIfc(editedModelBytes(f.source,f.view));assert.ok(storeyPlanFrame(independent,f.storey),'Unbounded historical source-only API remains readable; current view refuses excessive work');
 const plane=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.ok('refused' in plane);assert.match(plane.refused,/256/);
});

test('#7306 current frame reads preserve a held native preparation lease and follow Undo/Redo',async()=>{
 const f=await editedFrame(),lease=f.view.prepareAtomic(()=>null);const p=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.ok(isWorkplane(p));assert.deepEqual(p.localToRender([1,2,0]),[13,5,-21]);assert.doesNotThrow(()=>lease.validate(),'Pure frame read preserves the native preparation snapshot');
 recordModellingEdit(useViewerStore,SAMPLE_MODEL,(_methods,draft)=>draft.setPositionalAttribute(f.point,0,[25000,30000,5000]),'frame-edit');
 const edited=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.ok(isWorkplane(edited));assert.deepEqual(edited.localToRender([1,2,0]),[23,5,-31]);
 useViewerStore.getState().undo(SAMPLE_MODEL);const undone=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.ok(isWorkplane(undone));assert.deepEqual(undone.localToRender([1,2,0]),[13,5,-21]);
 useViewerStore.getState().redo(SAMPLE_MODEL);const redone=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.ok(isWorkplane(redone));assert.deepEqual(redone.localToRender([1,2,0]),[23,5,-31]);
});
test('#7306 source-free original placement does not resurrect a retained source accessor',async()=>{
 const f=await editedFrame(),state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL)!;useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:{...f.source,source:EMPTY_SOURCE_BYTES}}]])});
 const plane=buildStoreyWorkplane(useViewerStore.getState(),SAMPLE_MODEL,f.storey,0);assert.equal(isWorkplane(plane),false,'Unreadable original storey remains unavailable even while authored placement records are known');
});
