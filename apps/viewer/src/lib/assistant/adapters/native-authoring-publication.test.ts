/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, test } from 'node:test';
import { iterateEffectiveEntityIds, MutablePropertyView } from '@ifc-lite/mutations';
import { readHostedFill, readHostedElementSize, readWallJoinTarget } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { GROUND_STOREY,SAMPLE_MODEL,seedAuthoringSample,parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { readSplitSnapshot } from '@/lib/actions/model-authoring-split-state';
import { authoringReachEvidenceFromTarget } from '@/lib/actions/model-authoring-reach';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { captureEvidence } from '../evidence';
import { replaceEvidence,cancelAssistant,useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { undoModelChanges } from '@/lib/actions/model-change-commit';
const initial=useViewerStore.getState(),assistant=useAssistant.getState(),fetchBefore=globalThis.fetch;
afterEach(()=>{cancelAssistant();globalThis.fetch=fetchBefore;useAssistant.setState(assistant,true);useViewerStore.setState(initial,true)});
const s=useViewerStore.getState;
function rec(x:unknown):x is Record<string,unknown>{return typeof x==='object'&&x!==null&&!Array.isArray(x)}
function find(tree:unknown,predicate:(x:Record<string,unknown>)=>boolean):boolean{
 const todo=[tree];let work=0;while(todo.length){assert.ok(++work<20000,'bounded captured native evidence');const x=todo.pop();if(rec(x)){if(predicate(x))return true;todo.push(...Object.values(x))}else if(Array.isArray(x))todo.push(...x)}return false;
}
async function fixture(hosted:boolean){
 const {dataStore,view}=await seedAuthoringSample();const storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 const wall=s().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Workflow native wall'});assert.ok('expressId' in wall,'error' in wall?wall.error:'');
 let id=wall.expressId;if(hosted){const fill=s().addHostedFill(SAMPLE_MODEL,id,{kind:'window',params:{Offset:2,Sill:.7,Width:1,Height:1.2,Name:'Workflow native window'}});assert.ok('expressId' in fill,'error' in fill?fill.error:'');id=fill.expressId}
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.entities.getTypeName(id),hosted?'IfcWindow':'IfcWall');assert.ok(saved.entities.getGlobalId(id));
 const model=s().models.get(SAMPLE_MODEL)!,savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:getMaxExpressId(saved,[])}]]),ifcDataStore:saved,mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),selectedEntity:{modelId:SAMPLE_MODEL,expressId:id},selectedEntityId:id,selectedEntityIds:new Set([id]),selectedEntities:[],selectedEntitiesSet:new Set()});
 const target=readOnlyModelEditTarget(s(),SAMPLE_MODEL);assert.ok(target);return {id,saved,savedView,target};
}
for(const family of ['split','hosted','trim'] as const)for(const route of ['rich','attachment'] as const)test(`#7282 native authoring publication complete ${family} native expected snapshot reaches actual ${route} request`,async()=>{
 const f=await fixture(family==='hosted');const expected=family==='split'?readSplitSnapshot(f.saved,f.target.editor,f.id,'m'):family==='trim'?authoringReachEvidenceFromTarget(f.target,f.id):readHostedFill(f.saved,f.id);assert.ok(expected,'Actual supported public native creation and saved source reader must succeed before missing-wire assertion');
 if(family==='hosted')assert.deepEqual(readHostedElementSize(f.saved,f.id),{OverallWidth:1,OverallHeight:1.2});
 const snapshot=captureEvidence(route==='rich'?'selection':'loadReport');replaceEvidence(snapshot);const grounding=route==='attachment'?captureSelectionGrounding(s()):null;if(grounding){assert.equal(grounding.elements.length,1,'Canonical saved model range must resolve the selected native target');assert.equal(grounding.elements[0].globalId,f.saved.entities.getGlobalId(f.id));}
 let data:unknown,calls=0;globalThis.fetch=async(_url,init)=>{calls++;const wire=JSON.parse(String(init?.body));if(route==='rich'){
 const system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n');const at=system.indexOf(snapshot.payload);assert.ok(at>=0,'Actual provider system receives the frozen source payload');data=JSON.parse(system.slice(at,at+snapshot.payload.length)).evidence.rows[0].data;
 }else{const user=wire.messages.filter((m:{role:string})=>m.role==='user').at(-1);assert.equal(typeof user.content,'string');data=JSON.parse(user.content.split('\n').at(-1))[0]}
 assert.ok(rec(data));const target={modelId:data.modelId,globalId:data.globalId,ifcClass:data.type,name:data.name};
 const operation=family==='split'?{op:'element.split',target,expected:data.nativeSplitExpected,cut:{kind:'wall',distance:2}}:family==='hosted'?{op:'hosted.edit',target,expected:data.nativeHostedExpected,edit:{Offset:3,Sill:.9,OverallWidth:1.1,OverallHeight:1.3}}:{op:'element.trimExtend',target,expected:data.nativeTrimExtendExpected,mode:'extend',click:[8,5],boundary:{line:{a:[10,0],b:[10,10],tMin:0,tMax:1,reach:0}}};
 const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Wire-only proposal',units:'m',frame:'storey-local',operations:[operation]});
 return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`)};
 assert.equal(await sendAssistant('Prepare the selected native operation','openai/gpt-free','/api/chat',grounding?attachmentsForSend({selection:grounding,screenshot:null}):{}),true,useAssistant.getState().error??'');assert.equal(calls,1);assert.ok(rec(data));
 console.log(JSON.stringify({family,route,actualWireFields:Object.keys(data),nativeExpectedAvailable:true}));
 if(family==='hosted'){assert.ok(rec(expected));const ids=['hostId','openingId','fillingId','locationPointId'];assert.ok(find(data,obj=>ids.every(key=>obj[key]===expected[key])&&Object.hasOwn(obj,'location')&&Object.hasOwn(obj,'size')),'Complete canonical native hosted expected binding/size is absent from the real provider wire')}
 else assert.ok(find(data,obj=>isDeepStrictEqual(obj,expected)),`Complete canonical ${family} snapshot is absent from the real provider wire`);
 const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);const preview=previewModelAuthoring(s(),parseModelAuthoringBatch(answer));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'#7282 actual captured wire apply');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(editedModelBytes(f.saved,f.savedView));
 if(family==='hosted'){assert.deepEqual(readHostedElementSize(after,f.id),{OverallWidth:1.1,OverallHeight:1.3});assert.equal(readHostedFill(after,f.id)?.offset,3);assert.equal(readHostedFill(after,f.id)?.sill,.9);}
 else if(family==='trim')assert.deepEqual(readWallJoinTarget(after,new MutablePropertyView(after.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(after))?.wall.end,[10,5]);
 else {const wall=readWallJoinTarget(after,new MutablePropertyView(after.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(after));assert.ok(wall);assert.equal(Math.hypot(wall.wall.end[0]-wall.wall.start[0],wall.wall.end[1]-wall.wall.start[1]),6);assert.equal([...iterateEffectiveEntityIds(after,undefined,['IfcWall','IfcWallStandardCase'])].length,[...iterateEffectiveEntityIds(f.saved,undefined,['IfcWall','IfcWallStandardCase'])].length+1);}
 assert.ok(undoModelChanges(useViewerStore,result.receipt).ok);const undone=await parseIfc(editedModelBytes(f.saved,f.savedView));
 if(family==='hosted'){assert.deepEqual(readHostedElementSize(undone,f.id),{OverallWidth:1,OverallHeight:1.2});assert.equal(readHostedFill(undone,f.id)?.offset,2);assert.equal(readHostedFill(undone,f.id)?.sill,.7);}
 else assert.deepEqual(readWallJoinTarget(undone,new MutablePropertyView(undone.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(undone))?.wall.end,[8,5]);

});

test('#7282 native authoring publication existing rich Trim snapshot alone constructs a real streamed native proposal and Undo',async()=>{
 const f=await fixture(false),snapshot=captureEvidence('selection');replaceEvidence(snapshot);let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const wire=JSON.parse(String(init?.body)),system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n'),at=system.indexOf(snapshot.payload);assert.ok(at>=0);const row=JSON.parse(system.slice(at,at+snapshot.payload.length)).evidence.rows[0].data;assert.ok(row.nativeTrimExtendExpected);
 const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Native wire control',units:'m',frame:'storey-local',operations:[{op:'element.trimExtend',target:{modelId:row.modelId,globalId:row.globalId,ifcClass:row.type,name:row.name},expected:row.nativeTrimExtendExpected,mode:'extend',click:[8,5],boundary:{line:{a:[10,0],b:[10,10],tMin:0,tMax:1,reach:0}}}]});return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`)};
 assert.equal(await sendAssistant('Extend selected wall to x=10 metres','openai/gpt-free','/api/chat'),true,useAssistant.getState().error??'');assert.equal(calls,1);const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);const preview=previewModelAuthoring(s(),parseModelAuthoringBatch(answer));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'read-only workflow positive witness');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(editedModelBytes(f.saved,f.savedView));assert.deepEqual(readWallJoinTarget(after,new MutablePropertyView(after.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(after))?.wall.end,[10,5]);assert.ok(undoModelChanges(useViewerStore,result.receipt).ok);const undone=await parseIfc(editedModelBytes(f.saved,f.savedView));assert.deepEqual(readWallJoinTarget(undone,new MutablePropertyView(undone.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(undone))?.wall.end,[8,5]);
});
