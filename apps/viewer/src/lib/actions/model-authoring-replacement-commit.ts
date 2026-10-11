/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AuthoringTransaction } from '@/lib/commands/modeling/types';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { completeElementReplacement } from '@/store/slices/mutation-element-replacement';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview-types';
import type { AppliedChange } from './model-change-commit';
import { replacementElement,writeNativeReplacement } from './model-authoring-replacement';
export function commitNativeReplacement(tx:AuthoringTransaction,batch:ModelAuthoringBatch,row:AuthoringRow,refs:Map<string,string|number>,ids:Map<string,number>,written:{created:number[];deleted:number[];remesh:number[]}):AppliedChange[] {
 const op=row.op;if(op.op!=='element.replace')throw new Error('Not a native replacement row');
 const modelId=row.modelId!,store=tx.api.getState().models.get(modelId)?.ifcDataStore;if(!store)throw new Error('Native replacement source is unavailable');
 const before=tx.api.getState().undoStacks.get(modelId)?.length??0;
 const made=recordModellingEdit(tx.api,modelId,(_methods,editor)=>writeNativeReplacement(batch,store,editor,row.resolved.target!,row.resolved.storey!,op),tx.batchId);
 completeElementReplacement(tx.api,modelId,row.resolved.storey!,replacementElement(batch,op),made,before,false);
 const guid=tx.api.getState().mutationViews.get(modelId)?.getNewEntity(made.expressId)?.attributes[0];if(typeof guid!=='string')throw new Error('The native replacement has no GlobalId');
 ids.set(op.ref,made.expressId);refs.set(op.ref,guid);written.created.push(made.expressId,...(made.flightId===undefined?[]:[made.flightId]));written.deleted.push(...made.removedIds);written.remesh.push(made.flightId??made.expressId);
 return [{index:row.index,op:op.op,modelId,globalId:guid,field:op.ifcClass,before:op.target.globalId,after:op.name}];
}
