/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Actual public constructors, independent saved STEP sources for #7320. */
import { createBimContext } from '@ifc-lite/sdk';
import type { InStoreReplacementElement } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { configureMutationView } from '@/utils/configureMutationView';
import { GROUND_STOREY,SAMPLE_MODEL,seedAuthoringSample,parseIfc } from './authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
export const replacementVariants:InStoreReplacementElement[]=[
 {kind:'wall',params:{Start:[20,20,0],End:[26,20,0],Height:3,Thickness:.2,Name:'Original native wall'}},
 {kind:'column',params:{Position:[20,20,0],Width:.3,Depth:.4,Height:3,Name:'Original native column'}},
 {kind:'slab',params:{Position:[20,20,0],Width:6,Depth:4,Thickness:.25,Name:'Original native slab'}},
 {kind:'beam',params:{Start:[20,20,3],End:[26,20,3],Width:.3,Height:.4,Name:'Original native beam'}},
 {kind:'space',params:{Position:[20,20,0],Width:6,Depth:4,Height:3,Name:'Original native space'}},
 {kind:'roof',params:{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Original native roof'}},
 {kind:'plate',params:{Position:[20,20,0],Width:6,Depth:4,Thickness:.25,Name:'Original native plate'}},
 {kind:'member',params:{Start:[20,20,3],End:[26,20,3],Width:.3,Height:.4,Name:'Original native member'}},
 {kind:'stair',params:{Position:[20,20,0],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,Name:'Original native stair'}},
 {kind:'railing',params:{Path:[[20,20,0],[26,20,0]],Height:1.1,Name:'Original native railing'}},
];
export async function setupReplacementSource(element:InStoreReplacementElement){
 const {dataStore,view}=await seedAuthoringSample(),sdk=createBimContext({backend:new LocalBackend(useViewerStore)}),storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const add=(e:InStoreReplacementElement)=>{switch(e.kind){
  case 'wall':return sdk.store.addWall(SAMPLE_MODEL,storey,e.params);case 'column':return sdk.store.addColumn(SAMPLE_MODEL,storey,e.params);case 'slab':return sdk.store.addSlab(SAMPLE_MODEL,storey,e.params);case 'beam':return sdk.store.addBeam(SAMPLE_MODEL,storey,e.params);case 'space':return sdk.store.addSpace(SAMPLE_MODEL,storey,e.params);case 'roof':return sdk.store.addRoof(SAMPLE_MODEL,storey,e.params);case 'plate':return sdk.store.addPlate(SAMPLE_MODEL,storey,e.params);case 'member':return sdk.store.addMember(SAMPLE_MODEL,storey,e.params);case 'stair':return sdk.store.addStair(SAMPLE_MODEL,storey,e.params);case 'railing':return sdk.store.addRailing(SAMPLE_MODEL,storey,e.params);
 }};
 const made=add(element),saved=await parseIfc(editedModelBytes(dataStore,view)),savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);configureMutationView(savedView,saved);
 const state=useViewerStore.getState(),model=state.models.get(SAMPLE_MODEL);assert.ok(model);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:Math.max(...saved.entityIndex.byId.keys())}]]),mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),mutationBatchTags:new Map()});
 return {dataStore:saved,view:savedView,sdk,storey,made};
}

/** Test data translation only; actual production uses the existing parsers. */
export function replacementReviewParams(element:InStoreReplacementElement):unknown {
 switch(element.kind){
  case 'stair':case 'railing':return element.params;
  case 'wall':return {start:element.params.Start,end:element.params.End,height:element.params.Height,thickness:element.params.Thickness};
  case 'beam':case 'member':return {start:element.params.Start,end:element.params.End,...('Profile'in element.params?{Profile:element.params.Profile}:{width:element.params.Width,height:element.params.Height})};
  case 'column':return {position:element.params.Position,height:element.params.Height,...('Profile'in element.params?{Profile:element.params.Profile}:{width:element.params.Width,depth:element.params.Depth})};
  case 'slab':case 'roof':case 'plate':return {position:element.params.Position,thickness:element.params.Thickness,...('OuterCurve'in element.params?{Profile:'polygon',OuterCurve:element.params.OuterCurve}:{width:element.params.Width,depth:element.params.Depth})};
  case 'space':return {position:element.params.Position,height:element.params.Height,...('OuterCurve'in element.params?{Profile:'polygon',OuterCurve:element.params.OuterCurve}:{width:element.params.Width,depth:element.params.Depth})};
 }
}
