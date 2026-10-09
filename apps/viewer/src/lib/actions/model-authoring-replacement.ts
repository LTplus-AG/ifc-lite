/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #7320: current native replacement evidence and one writer for draft/commit. */
import { effectiveMetadataRecord,type IfcDataStore } from '@ifc-lite/parser';
import { readRelatedLists,liveEntityConforms,replaceElementInStore,resolveSpatialAnchor,type InStoreReplacementElement } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import { readSplitPlacement } from '../../../../../packages/create/src/in-store/element-split-placement';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { authoredElementOf } from './model-authoring-native';
import type { ModelAuthoringBatch,AuthoringOp } from './model-authoring';
import type { NativeReplacementOp } from './model-authoring-replacement-fields';
import { stairParamsInMetres,railingParamsInMetres } from './model-authoring-stair-railing-fields';
import { sameSplitSnapshot } from './model-authoring-split-state';
import { uniqueSplitGuid } from './model-authoring-split';
export interface NativeReplacementExpected {
 record:{type:string;attributes:unknown[]};
 placement:ReturnType<typeof readSplitPlacement>;
 storeyId:number;
 types:{expressId:number;record:{type:string;attributes:unknown[]};relationshipId:number;relatedIds:number[]}[];
 materials:{expressId:number;record:{type:string;attributes:unknown[]};relationshipId:number;relatedIds:number[]}[];
}
const families=['IfcWall','IfcSlab','IfcRoof','IfcPlate','IfcColumn','IfcBeam','IfcMember','IfcSpace','IfcStair','IfcRailing'];
/** Raw native attribute/reference pins and placement basis keep native units;
 * destination lengths alone use the batch's declared m/mm conversion. */
export function readNativeReplacementExpected(store:IfcDataStore,editor:StoreEditor,id:number):NativeReplacementExpected {
 const view=editor.getMutationView();
 if(!store.source.byteLength||!families.some(kind=>liveEntityConforms(store,id,kind,view)))throw new Error('Current native replacement source is unavailable or unsupported');
 const record=effectiveMetadataRecord(store,id,view),storeyId=effectiveStoreyId(store,view,id);
 if(!record||storeyId===undefined||typeof record.attributes[0]!=='string'||!uniqueSplitGuid(store,editor,record.attributes[0]))throw new Error('Current native replacement identity/storey is unavailable or ambiguous');
 const placement=readSplitPlacement({dataStore:store,editor,view,storeyExpressId:storeyId,lengthUnitScale:getModelLengthUnitScale(store),newGlobalId:record.attributes[0],name:String(record.attributes[2]??'')},id);
 const associations=(kind:'IfcRelDefinesByType'|'IfcRelAssociatesMaterial')=>{
  const rows=readRelatedLists(store,kind,view).filter(row=>row.relatedIds.includes(id));
  if(rows.length>256)throw new Error('Native replacement association population exceeds256; no memberships are omitted');
  return rows.map(row=>{const record=effectiveMetadataRecord(store,row.relatingId,view);if(!record)throw new Error('A current native replacement association is unreadable');
   if(kind==='IfcRelDefinesByType'&&(typeof record.attributes[0]!=='string'||!uniqueSplitGuid(store,editor,record.attributes[0])))throw new Error('Current native replacement type identity is ambiguous');
   return {expressId:row.relatingId,record,relationshipId:row.relId,relatedIds:row.relatedIds};});
 };
 const result={record,placement,storeyId,types:associations('IfcRelDefinesByType'),materials:associations('IfcRelAssociatesMaterial')};
 // Compare with the existing bounded native snapshot comparator; an oversized
 // expected record is unavailable, not a smaller pin or a successful prefix.
 if(!sameSplitSnapshot(result,structuredClone(result)))throw new Error('Complete native replacement expectation exceeds the snapshot work bound');
 return result;
}
export function nativeReplacementEvidence(target:ModelEditTarget|null,id:number):NativeReplacementExpected|null {
 if(!target||!nativeLengthUnitAvailable(target))return null;
 try{return readNativeReplacementExpected(target.dataStore,target.editor,id);}catch(error){if(!(error instanceof Error))throw error;console.warn("[Native replacement] Current complete snapshot is unavailable",error);return null;}
}
export function replacementCreation(op:NativeReplacementOp):Extract<AuthoringOp,{op:'element.create'|'stair.create'|'railing.create'}> {
 if(op.ifcClass==='IfcStair')return {op:'stair.create',ref:op.ref,storey:op.storey,params:op.params};
 if(op.ifcClass==='IfcRailing')return {op:'railing.create',ref:op.ref,storey:op.storey,params:op.params};
 return {op:'element.create',ref:op.ref,storey:op.storey,ifcClass:op.ifcClass,name:op.name,params:op.params};
}
export function replacementElement(batch:ModelAuthoringBatch,op:NativeReplacementOp):InStoreReplacementElement {
 const creation=replacementCreation(op);
 if(creation.op==='stair.create')return {kind:'stair',params:stairParamsInMetres(creation.params,batch.units)};
 if(creation.op==='railing.create')return {kind:'railing',params:railingParamsInMetres(creation.params,batch.units)};
 return authoredElementOf(batch,creation);
}
/** Both native dry run and commit recheck the same current intermediate view. */
export function verifyReplacementExpected(store:IfcDataStore,editor:StoreEditor,id:number,op:NativeReplacementOp):NativeReplacementExpected {
 const current=readNativeReplacementExpected(store,editor,id);
 if(current.record.attributes[0]!==op.target.globalId||(current.record.attributes[2]??'')!==op.target.name||!liveEntityConforms(store,id,op.target.ifcClass,editor.getMutationView())||!sameSplitSnapshot(current,op.expected))throw new Error('The current native replacement identity, placement, type or material differs from expected');
 return current;
}
export function writeNativeReplacement(batch:ModelAuthoringBatch,store:IfcDataStore,editor:StoreEditor,id:number,storeyId:number,op:NativeReplacementOp){
 verifyReplacementExpected(store,editor,id,op);
 const storey=effectiveMetadataRecord(store,storeyId,editor.getMutationView()),guid=storey?.attributes[0];
 if(typeof guid!=='string'||guid!==op.storey.globalId||!uniqueSplitGuid(store,editor,guid)||!liveEntityConforms(store,storeyId,'IfcBuildingStorey',editor.getMutationView()))throw new Error('The current replacement destination storey is unavailable or ambiguous');
 const made=replaceElementInStore(store,editor,id,draft=>{ensureStoreyPlacement(store,draft,storeyId);return resolveSpatialAnchor(store,storeyId,draft.getMutationView());},replacementElement(batch,op));
 for(const root of [made.expressId,...(made.flightId===undefined?[]:[made.flightId])]){const guid=effectiveMetadataRecord(store,root,editor.getMutationView())?.attributes[0];if(typeof guid!=='string'||!uniqueSplitGuid(store,editor,guid))throw new Error('Native replacement produced a duplicate Root GlobalId');}
 return made;
}
