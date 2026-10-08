/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readStairDimensions } from '@ifc-lite/create';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { undoModelChanges } from '@/lib/actions/model-change-commit';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { useViewerStore } from '@/store';
import { GROUND_STOREY,SAMPLE_MODEL,seedAuthoringSample,parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { captureEvidence } from '../evidence';
import { replaceEvidence,cancelAssistant,useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
const initial=useViewerStore.getState(),assistant=useAssistant.getState(),fetchBefore=globalThis.fetch;
afterEach(()=>{cancelAssistant();globalThis.fetch=fetchBefore;useAssistant.setState(assistant,true);useViewerStore.setState(initial,true)});
const s=useViewerStore.getState;
function rec(x:unknown):x is Record<string,unknown>{return typeof x==='object'&&x!==null&&!Array.isArray(x)}
function find(tree:unknown,predicate:(x:Record<string,unknown>)=>boolean):boolean{
 const todo=[tree];let work=0;while(todo.length){assert.ok(++work<20000,'bounded captured native evidence');const x=todo.pop();if(rec(x)){if(predicate(x))return true;todo.push(...Object.values(x))}else if(Array.isArray(x))todo.push(...x)}return false;
}
async function fixture(){
 const {dataStore,view}=await seedAuthoringSample();const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),api=createStoreAdapter(useViewerStore);assert.ok(api.addStair);
 const made=api.addStair(SAMPLE_MODEL,storey,{Position:[0,5,0],NumberOfRisers:4,RiserHeight:.2,TreadLength:.3,Width:1,WaistThickness:.1,Name:'Stair workflow'}),id=made.expressId;
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.entities.getTypeName(id),'IfcStair');assert.ok(saved.entities.getGlobalId(id));const dimensions=readStairDimensions(saved,id);assert.ok(dimensions);assert.equal(dimensions.NumberOfRisers,4);assert.equal(dimensions.Width,1);
 const model=s().models.get(SAMPLE_MODEL)!,savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:getMaxExpressId(saved,[])}]]),ifcDataStore:saved,mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),selectedEntity:{modelId:SAMPLE_MODEL,expressId:id},selectedEntityId:id,selectedEntityIds:new Set([id]),selectedEntities:[],selectedEntitiesSet:new Set()});
 const target=readOnlyModelEditTarget(s(),SAMPLE_MODEL);assert.ok(target);return {id,saved,savedView,target};
}
for(const route of ['rich','attachment'] as const)test(`#7282 native Stair publication complete Stair native expected snapshot reaches actual ${route} request`,async()=>{
 const f=await fixture(),expected=readStairDimensions(f.saved,f.id);assert.ok(expected,'Actual native saved stair reader succeeds before missing-wire assertion');
 const snapshot=captureEvidence(route==='rich'?'selection':'loadReport');replaceEvidence(snapshot);const grounding=route==='attachment'?captureSelectionGrounding(s()):null;if(grounding){assert.equal(grounding.elements.length,1,'Canonical saved model range must resolve the selected native target');assert.equal(grounding.elements[0].globalId,f.saved.entities.getGlobalId(f.id));}
 let data:unknown,calls=0;globalThis.fetch=async(_url,init)=>{calls++;const wire=JSON.parse(String(init?.body));if(route==='rich'){
 const system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n');const at=system.indexOf(snapshot.payload);assert.ok(at>=0,'Actual provider system receives the frozen source payload');data=JSON.parse(system.slice(at,at+snapshot.payload.length)).evidence.rows[0].data;
 }else{const user=wire.messages.filter((m:{role:string})=>m.role==='user').at(-1);assert.equal(typeof user.content,'string');data=JSON.parse(user.content.split('\n').at(-1))[0]}
 assert.ok(rec(data));const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Captured stair',units:'m',frame:'storey-local',operations:[{op:'stair.resize',target:{modelId:data.modelId,globalId:data.globalId,ifcClass:data.type,name:data.name},expected:data.nativeStairExpected,size:{Width:1.5}}]});return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`)};
 assert.equal(await sendAssistant('Prepare the selected native operation','openai/gpt-free','/api/chat',grounding?attachmentsForSend({selection:grounding,screenshot:null}):{}),true,useAssistant.getState().error??'');assert.equal(calls,1);assert.ok(rec(data));
 console.log(JSON.stringify({family:'stair',route,actualWireFields:Object.keys(data),nativeExpectedAvailable:true}));
 assert.ok(find(data,obj=>isDeepStrictEqual(obj,expected)), 'Complete canonical Stair expected snapshot is absent from the real provider wire');
 const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);const preview=previewModelAuthoring(s(),parseModelAuthoringBatch(answer));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'#7282 captured stair apply');assert.ok(result.ok,result.ok?'':result.detail??result.reason);const after=await parseIfc(editedModelBytes(f.saved,f.savedView));assert.equal(readStairDimensions(after,f.id)?.Width,1.5);assert.equal(readStairDimensions(after,f.id)?.flightId,expected.flightId);assert.ok(undoModelChanges(useViewerStore,result.receipt).ok);const undone=await parseIfc(editedModelBytes(f.saved,f.savedView));assert.equal(readStairDimensions(undone,f.id)?.Width,1);assert.equal(readStairDimensions(undone,f.id)?.flightId,expected.flightId);
});
