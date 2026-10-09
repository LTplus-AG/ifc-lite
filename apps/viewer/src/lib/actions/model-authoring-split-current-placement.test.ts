/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { StoreEditor,MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { seedAuthoringSample,parseIfc,SAMPLE_MODEL,GROUND_STOREY } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readSplitSnapshot } from './model-authoring-split-state';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
async function fixture(){
 const {dataStore,view}=await seedAuthoringSample(),storeyId=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const made=useViewerStore.getState().addSlab(SAMPLE_MODEL,storeyId,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Current native placement'});assert.ok('expressId' in made,'error' in made?made.error:'');
 const store=await parseIfc(editedModelBytes(dataStore,view)),currentView=new MutablePropertyView(store.properties,SAMPLE_MODEL),editor=new StoreEditor(store,currentView);
 const original=store.getEntity(made.expressId);assert.ok(original);const localId=Number(original.attributes[5]);assert.ok(store.getEntity(localId));
 return {store,view:currentView,editor,id:made.expressId,localId};
}
for(const slot of ['RelativePlacement','ObjectPlacement'] as const)for(const mode of ['named','positional'] as const)
test(`#7315 real native ${mode} ${slot} retarget snapshot agrees with independently exported current axis`,async()=>{
 const f=await fixture(),old=readSplitSnapshot(f.store,f.editor,f.id,'m');
 const point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),direction=f.editor.addEntity('IfcDirection',[[1,0,0]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,`#${direction.expressId}`]);
 const target=slot==='RelativePlacement'?f.localId:f.id;
 const reference=slot==='RelativePlacement'?axis.expressId:f.editor.addEntity('IfcLocalPlacement',[f.store.getEntity(f.localId)?.attributes[0],`#${axis.expressId}`]).expressId;
 if(mode==='named')f.editor.setAttribute(target,slot,`#${reference}`);else f.editor.setPositionalAttribute(target,slot==='RelativePlacement'?1:5,`#${reference}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view)),savedEditor=new StoreEditor(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL));
 assert.equal(Number(saved.getEntity(target)?.attributes[slot==='RelativePlacement'?1:5]),reference,'public STEP export proves the exact native reference edit');
 const expected=readSplitSnapshot(saved,savedEditor,f.id,'m');assert.deepEqual(expected.placement.frame.o,[22,21,3]);assert.deepEqual(expected.placement.frame.x,[1,0,0]);assert.notDeepEqual(expected.placement,old.placement);
 assert.deepEqual(readSplitSnapshot(f.store,f.editor,f.id,'m').placement,expected.placement,'current native parent/basis must match the independently reparsed source');
});
test('#7315 full native snapshot chain follows the same current named axis as its placement',async()=>{
 const f=await fixture(),point=f.editor.addEntity('IfcCartesianPoint',[[22000,21000,3000]]),axis=f.editor.addEntity('IfcAxis2Placement3D',[`#${point.expressId}`,null,null]);
 f.editor.setAttribute(f.localId,'RelativePlacement',`#${axis.expressId}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view)),savedEditor=new StoreEditor(saved,new MutablePropertyView(saved.properties,SAMPLE_MODEL));
 assert.deepEqual(readSplitSnapshot(f.store,f.editor,f.id,'m').chain,readSplitSnapshot(saved,savedEditor,f.id,'m').chain,'native shape-chain provenance and placement origin must use the same effective reference');
});
test('#7315 current named parent cycle is refused rather than attested as a native basis',async()=>{
 const f=await fixture();f.editor.setAttribute(f.localId,'PlacementRelTo',`#${f.localId}`);
 const saved=await parseIfc(editedModelBytes(f.store,f.view));assert.equal(saved.getEntity(f.localId)?.attributes[0],f.localId,'the public native export proves the cyclic reference');
 assert.throws(()=>readSplitSnapshot(f.store,f.editor,f.id,'m'),/placement|basis|shape|Split/i,'a live named cycle must refuse just as an independently saved cycle does');
});
