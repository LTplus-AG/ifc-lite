/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, test } from 'node:test';
import { iterateEffectiveEntityIds, MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { IfcCreator, readHostedFill, readHostedElementSize, readWallJoinTarget } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { GROUND_STOREY,SAMPLE_MODEL,seedAuthoringSample,parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readOnlyModelEditLease, readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
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
// #7282: the simulated provider converts only the documented SI dimensional
// fields received on the wire; native IDs/directions and Trim pins stay verbatim.
function millimetrePin(value:unknown,family:'split'|'hosted'):unknown {
 assert.ok(rec(value));const scale=(v:unknown):unknown=>Array.isArray(v)?v.map(scale):typeof v==='number'?v*1000:v;
 if(family==='hosted')return {...value,location:scale(value.location),offset:scale(value.offset),sill:scale(value.sill),size:value.size===null?null:scaleRecord(value.size)};
 assert.ok(rec(value.chain)&&rec(value.placement)&&rec(value.placement.frame));
 const lengths=new Set(['startCoordinates','wallLength','thickness','height','depth','profileWidth','profileHeight','placementOrigin','baseElevation','footprint']);
 const chain=Object.fromEntries(Object.entries(value.chain).map(([key,v])=>[key,lengths.has(key)?scale(v):key==='profile'&&rec(v)?Object.fromEntries(Object.entries(v).map(([field,entry])=>[field,field==='Type'?entry:scale(entry)])):v]));
 return {...value,chain,placement:{...value.placement,frame:{...value.placement.frame,o:scale(value.placement.frame.o)}}};
 function scaleRecord(v:unknown){assert.ok(rec(v));return Object.fromEntries(Object.entries(v).map(([key,n])=>[key,scale(n)]));}
}
async function fixture(hosted:boolean,fileUnit:'m'|'sample-mm'='sample-mm',federated=false){
 federationRegistry.clear();
 let {dataStore,view}=await seedAuthoringSample();let storey=dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
 if(fileUnit==='m'){const creator=new IfcCreator({Schema:'IFC4',LengthUnit:'METRE',Name:'Native publication units'});storey=creator.addIfcBuildingStorey({Name:'Level',Elevation:0});dataStore=await parseIfc(new TextEncoder().encode(creator.toIfc().content));view=new MutablePropertyView(dataStore.properties,SAMPLE_MODEL);useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...s().models.get(SAMPLE_MODEL)!,ifcDataStore:dataStore,maxExpressId:getMaxExpressId(dataStore,[])}]]),ifcDataStore:dataStore,mutationViews:new Map([[SAMPLE_MODEL,view]]),storeEditors:new Map()});}

 const wall=s().addWall(SAMPLE_MODEL,storey,{Start:[0,5,0],End:[8,5,0],Thickness:.2,Height:3,Name:'Workflow native wall'});assert.ok('expressId' in wall,'error' in wall?wall.error:'');
 let id=wall.expressId;if(hosted){const fill=s().addHostedFill(SAMPLE_MODEL,id,{kind:'window',params:{Offset:2,Sill:.7,Width:1,Height:1.2,Name:'Workflow native window'}});assert.ok('expressId' in fill,'error' in fill?fill.error:'');id=fill.expressId}
 const saved=await parseIfc(editedModelBytes(dataStore,view));assert.equal(saved.entities.getTypeName(id),hosted?'IfcWindow':'IfcWall');assert.ok(saved.entities.getGlobalId(id));
 const model=s().models.get(SAMPLE_MODEL)!,savedView=new MutablePropertyView(saved.properties,SAMPLE_MODEL);
 useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...model,ifcDataStore:saved,maxExpressId:getMaxExpressId(saved,[])}]]),ifcDataStore:saved,mutationViews:new Map([[SAMPLE_MODEL,savedView]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map(),selectedEntity:{modelId:SAMPLE_MODEL,expressId:id},selectedEntityId:id,selectedEntityIds:new Set([id]),selectedEntities:[],selectedEntitiesSet:new Set()});
 let selectedStore=saved,selectedView=savedView,modelId=SAMPLE_MODEL;
 if(federated){const firstOffset=s().registerModelOffset(SAMPLE_MODEL,getMaxExpressId(saved,[]));modelId='peer';selectedStore=await parseIfc(saved.source.materialize());selectedView=new MutablePropertyView(selectedStore.properties,modelId);const peerOffset=s().registerModelOffset(modelId,getMaxExpressId(selectedStore,[]));useViewerStore.setState({models:new Map([[SAMPLE_MODEL,{...s().models.get(SAMPLE_MODEL)!,idOffset:firstOffset}],[modelId,{...model,id:modelId,idOffset:peerOffset,ifcDataStore:selectedStore,maxExpressId:getMaxExpressId(selectedStore,[])}]]),mutationViews:new Map([[SAMPLE_MODEL,savedView],[modelId,selectedView]]),selectedEntity:{modelId,expressId:id},selectedEntityId:null,selectedEntityIds:new Set()});const rendererId=s().toGlobalId(modelId,id);assert.equal(s().resolveGlobalIdFromModels(rendererId)?.modelId,modelId);useViewerStore.setState({selectedEntityId:rendererId,selectedEntityIds:new Set([rendererId])});assert.equal(selectedStore.entities.getGlobalId(id),saved.entities.getGlobalId(id),'Same GUID in distinct real saved IFC sources exercises ownership');}
 const target=readOnlyModelEditTarget(s(),modelId);assert.ok(target);return {id,saved:selectedStore,savedView:selectedView,target,modelId,unrelated:federated?{store:saved,view:savedView}:null};
}
for(const fileUnit of ['m','sample-mm'] as const)for(const federated of [false,true])for(const family of ['split','hosted','trim'] as const)for(const route of ['rich','attachment'] as const)test(`#7282 native authoring publication ${fileUnit} ${federated?'N':'1'} complete ${family} native expected snapshot reaches actual ${route} request`,async()=>{
 const f=await fixture(family==='hosted',fileUnit,federated),commandUnits=fileUnit==='m'?'mm':'m',factor=commandUnits==='mm'?1000:1;const expected=family==='split'?readSplitSnapshot(f.saved,f.target.editor,f.id,'m'):family==='trim'?authoringReachEvidenceFromTarget(f.target,f.id):readHostedFill(f.saved,f.id);assert.ok(expected,'Actual supported public native creation and saved source reader must succeed before missing-wire assertion');
 if(family==='hosted')assert.deepEqual(readHostedElementSize(f.saved,f.id),{OverallWidth:1,OverallHeight:1.2});
 const held=s(),lease=readOnlyModelEditLease(held,f.modelId);assert.ok(lease);const journals=f.savedView.getMutations();
 const snapshot=captureEvidence(route==='rich'?'selection':'loadReport');replaceEvidence(snapshot);const grounding=route==='attachment'?captureSelectionGrounding(s()):null;if(grounding){assert.equal(grounding.elements.length,1,'Canonical saved model range must resolve the selected native target');assert.equal(grounding.elements[0].globalId,f.saved.entities.getGlobalId(f.id));}
 let data:unknown,calls=0;globalThis.fetch=async(_url,init)=>{calls++;const wire=JSON.parse(String(init?.body));if(route==='rich'){
 const system=typeof wire.system==='string'?wire.system:wire.system.map((block:{text:string})=>block.text).join('\n');const at=system.indexOf(snapshot.payload);assert.ok(at>=0,'Actual provider system receives the frozen source payload');data=JSON.parse(system.slice(at,at+snapshot.payload.length)).evidence.rows[0].data;
 }else{const user=wire.messages.filter((m:{role:string})=>m.role==='user').at(-1);assert.equal(typeof user.content,'string');data=JSON.parse(user.content.split('\n').at(-1))[0]}
 assert.ok(rec(data));const target={modelId:data.modelId,globalId:data.globalId,ifcClass:data.type,name:data.name};
 const operation=family==='split'?{op:'element.split',target,expected:factor===1?data.nativeSplitExpected:millimetrePin(data.nativeSplitExpected,'split'),cut:{kind:'wall',distance:2*factor}}:family==='hosted'?{op:'hosted.edit',target,expected:factor===1?data.nativeHostedExpected:millimetrePin(data.nativeHostedExpected,'hosted'),edit:{Offset:3*factor,Sill:.9*factor,OverallWidth:1.1*factor,OverallHeight:1.3*factor}}:{op:'element.trimExtend',target,expected:data.nativeTrimExtendExpected,mode:'extend',click:[8*factor,5*factor],boundary:{line:{a:[10*factor,0],b:[10*factor,10*factor],tMin:0,tMax:1,reach:0}}};
 const answer=JSON.stringify({version:1,kind:'model.authoring',title:'Wire-only proposal',units:commandUnits,frame:'storey-local',operations:[operation]});
 return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`)};
 assert.equal(await sendAssistant('Prepare the selected native operation','openai/gpt-free','/api/chat',grounding?attachmentsForSend({selection:grounding,screenshot:null}):{}),true,useAssistant.getState().error??'');assert.equal(calls,1);assert.ok(rec(data));assert.equal(data.modelId,f.modelId);assert.equal(s(),held,'Capture/transport never publishes source or map state');assert.deepEqual(f.savedView.getMutations(),journals);assert.doesNotThrow(lease.validate,'Capture preserves native allocator and held prepared lease');
 console.log(JSON.stringify({family,route,actualWireFields:Object.keys(data),nativeExpectedAvailable:true}));
 if(family==='hosted'){assert.ok(rec(expected));const ids=['hostId','openingId','fillingId','locationPointId'];assert.ok(find(data,obj=>ids.every(key=>obj[key]===expected[key])&&Object.hasOwn(obj,'location')&&Object.hasOwn(obj,'size')),'Complete canonical native hosted expected binding/size is absent from the real provider wire')}
 else assert.ok(find(data,obj=>isDeepStrictEqual(obj,expected)),`Complete canonical ${family} snapshot is absent from the real provider wire`);
 const answer=useAssistant.getState().messages.at(-1)?.content;assert.ok(answer);const preview=previewModelAuthoring(s(),parseModelAuthoringBatch(answer));assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'#7282 actual captured wire apply');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(editedModelBytes(f.saved,f.savedView));
 if(family==='hosted'){assert.deepEqual(readHostedElementSize(after,f.id),{OverallWidth:1.1,OverallHeight:1.3});assert.equal(readHostedFill(after,f.id)?.offset,3);assert.equal(readHostedFill(after,f.id)?.sill,.9);}
 else if(family==='trim')assert.deepEqual(readWallJoinTarget(after,new MutablePropertyView(after.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(after))?.wall.end,[10,5]);
 else {const wall=readWallJoinTarget(after,new MutablePropertyView(after.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(after));assert.ok(wall);assert.equal(Math.hypot(wall.wall.end[0]-wall.wall.start[0],wall.wall.end[1]-wall.wall.start[1]),6);assert.equal([...iterateEffectiveEntityIds(after,undefined,['IfcWall','IfcWallStandardCase'])].length,[...iterateEffectiveEntityIds(f.saved,undefined,['IfcWall','IfcWallStandardCase'])].length+1);}
 if(f.unrelated){const untouched=await parseIfc(editedModelBytes(f.unrelated.store,f.unrelated.view));assert.equal(untouched.entities.getGlobalId(f.id),f.unrelated.store.entities.getGlobalId(f.id));if(family==='hosted'){assert.equal(readHostedFill(untouched,f.id)?.offset,2);assert.deepEqual(readHostedElementSize(untouched,f.id),{OverallWidth:1,OverallHeight:1.2});}else assert.deepEqual(readWallJoinTarget(untouched,new MutablePropertyView(untouched.properties,SAMPLE_MODEL),f.id,getModelLengthUnitScale(untouched))?.wall.end,[8,5]);}
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
