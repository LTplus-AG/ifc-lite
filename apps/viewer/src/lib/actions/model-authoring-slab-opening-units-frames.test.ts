/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { readHostOpeningExtents } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedModelingSession,MODEL_ID,STOREY } from '@/test/modeling-session-fixture';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { authoringReader } from './model-authoring-read';
import { readSplitSnapshot } from './model-authoring-split-state';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { authoringGhosts } from './model-authoring-ghost';
import { buildStoreyWorkplane,isWorkplane } from '@/lib/commands/modeling/workplane';
const initial=useViewerStore.getState();afterEach(()=>useViewerStore.setState(initial));
for(const unit of ['metre','millimetre'] as const)for(const declared of ['m','mm'] as const)
test(`#7310 native ${unit} model receives declared ${declared} slab cut on an actual translated/rotated storey`,async()=>{
 const view=await seedModelingSession({unit}),state=useViewerStore.getState(),store=state.models.get(MODEL_ID)?.ifcDataStore;assert.ok(store);
 const editor=new StoreEditor(store,view),nativeFactor=unit==='millimetre'?1000:1;
 const storey=store.getEntity(STOREY);assert.ok(storey);const local=store.getEntity(Number(storey.attributes[5]));assert.ok(local);
 const axisId=Number(local.attributes[1]),point=editor.addEntity('IfcCartesianPoint',[[100*nativeFactor,-50*nativeFactor,0]]),direction=editor.addEntity('IfcDirection',[[0,1,0]]);
 editor.setPositionalAttribute(axisId,0,`#${point.expressId}`);editor.setPositionalAttribute(axisId,2,`#${direction.expressId}`);
 const made=state.addSlab(MODEL_ID,STOREY,{Position:[20,20,3],Width:6,Depth:4,Thickness:.25,Name:'Native frame slab'});assert.ok('expressId' in made,'error' in made?made.error:'');
 const saved=await parseIfc(editedModelBytes(store,view));assert.deepEqual(saved.getEntity(point.expressId)?.attributes[0],[100*nativeFactor,-50*nativeFactor,0]);assert.deepEqual(saved.getEntity(direction.expressId)?.attributes[0],[0,1,0],'the public editor exports an actual rotated storey IFC frame');
 const reader=authoringReader(useViewerStore.getState(),MODEL_ID);assert.ok(reader);const factor=declared==='mm'?1000:1;
 const batch=parseModelAuthoringBatch(JSON.stringify({version:1,kind:'model.authoring',title:'Native unit/frame slab cut',units:declared,frame:'storey-local',operations:[{op:'hosted.create',kind:'opening',host:{modelId:MODEL_ID,globalId:saved.entities.getGlobalId(made.expressId),ifcClass:'IfcSlab',name:saved.entities.getName(made.expressId)},expected:readSplitSnapshot(store,reader.editor,made.expressId,declared),params:{Position:[2*factor,factor],Width:factor,Depth:.8*factor}}]}));
 const preview=previewModelAuthoring(useViewerStore.getState(),batch);assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);assert.equal(preview.rows[0].previewUnavailable,false);
 const ghosts=authoringGhosts(useViewerStore.getState(),preview);assert.equal(ghosts.length,1);
 const plane=buildStoreyWorkplane(useViewerStore.getState(),MODEL_ID,STOREY,0);assert.ok(isWorkplane(plane));
 const points:[number,number,number][]=[];for(let i=0;i<ghosts[0].positions.length;i+=3)points.push(plane.renderToLocal([ghosts[0].positions[i],ghosts[0].positions[i+1],ghosts[0].positions[i+2]]));
 const xs=points.map(p=>p[0]);assert.ok(Math.abs(Math.min(...xs)-21.5)<.001);assert.ok(Math.abs(Math.max(...xs)-22.5)<.001,'current translated/rotated workplane projects the native cutter in the owning storey');
 const result=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native slab units/frame');assert.ok(result.ok,result.ok?'':result.detail??result.reason);
 const after=await parseIfc(editedModelBytes(store,view)),cut=readHostOpeningExtents(after,made.expressId).cuts[0];assert.ok(cut);assert.ok(Math.abs(cut.bounds.min[0]/nativeFactor-1.5)<1e-9);assert.ok(Math.abs(cut.bounds.max[2]/nativeFactor-.3)<1e-9);
 assert.deepEqual(undoModelChanges(useViewerStore,result.receipt),{ok:true});assert.equal(readHostOpeningExtents(await parseIfc(editedModelBytes(store,view)),made.expressId).cuts.length,0);
});
