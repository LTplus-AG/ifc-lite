/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

const MODEL='quantity',ID=1222;
async function seed(authored:boolean) {
  const bytes=readFileSync(new URL('../../../public/samples/hello-wall.ifc',import.meta.url));
  let store=await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),{disableWorkerScan:true});
  const qset=authored?'Qto_Authored':'Qto_Source';
  const name='Area';
  if(!authored) {
    // Materialize the canonical Qto in retained IFC bytes, preserving the real Bonsai products.
    const baseline=new MutablePropertyView(null,MODEL);
    new StoreEditor(store,baseline).addQuantitySet(ID,qset,[{name,value:12,quantityType:'AREA'}]);
    const exported=new StepExporter(store,baseline).export({schema:'IFC4',applyMutations:true}).content;
    store=await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
  }
  const view=new MutablePropertyView(null,MODEL);
  view.setQuantityExtractor(id=>extractQuantitiesOnDemand(store,id));
  if(authored) view.createQuantitySet(ID,qset,[{name,value:12,quantityType:QuantityType.Area,unit:'m2'}]);
  useViewerStore.setState({...fixtureModels({...fixtureModel(MODEL),ifcDataStore:store}),mutationViews:new Map([[MODEL,view]]),undoStacks:new Map(),redoStacks:new Map(),mutationBatchTags:new Map(),editEnabled:true,collabRoomId:null,canCollabEdit:()=>true});
  const read=()=> {
    const quantity=view.getQuantitiesForEntity(ID).find(set=>set.name===qset)!.quantities.find(quantity=>quantity.name===name)!;
    return structuredClone({...quantity,unit:quantity.unit});
  };
  return {view,qset,name,read};
}

for(const authored of [false,true]) it(`#6232 ${authored?'authored':'source'} quantity type and unit survive real viewer Undo/Redo`,async()=>{
  const {view,qset,name,read}=await seed(authored),before=read();
  assert.equal(before.type,QuantityType.Area);
  const mutation=view.setQuantity(ID,qset,name,7,QuantityType.Volume,null);
  useViewerStore.getState().recordMutationBatch(MODEL,[mutation]);
  const after=read();assert.equal(after.type,QuantityType.Volume);assert.equal(after.unit,undefined);
  useViewerStore.getState().undo(MODEL);assert.deepEqual(read(),before);
  useViewerStore.getState().redo(MODEL);assert.deepEqual(read(),after);
  assert.equal(mutation.oldQuantityType,before.type);
  assert.equal(mutation.oldUnit,before.unit??null);
});

it('#6232 legacy quantity history restores value while retaining effective metadata without guessing a lost prior type',async()=>{
  const {view,qset,name,read}=await seed(true),before=read();
  const mutation=view.setQuantity(ID,qset,name,7,QuantityType.Volume,'m3');
  delete mutation.oldQuantityType;delete mutation.oldUnit;
  useViewerStore.getState().recordMutationBatch(MODEL,[mutation]);
  const effective=read();
  useViewerStore.getState().undo(MODEL);
  assert.deepEqual(read(),{...effective,value:before.value});
  useViewerStore.getState().redo(MODEL);assert.deepEqual(read(),effective);
});
