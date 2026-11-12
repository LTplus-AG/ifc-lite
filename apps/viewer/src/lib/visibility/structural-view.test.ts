/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { fixtureModel } from '@/test/store-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import { hasStructuralData, resolveViewHiddenEntities, structuralGlyphsVisible } from './structural-view';
import { sceneSnapshotKey } from '@/components/viewer/sceneSnapshotOwnership';

for (const count of [1,2]) {
  it(`#9923: mode masks newly authored physical and analytical products (${count} models)`, () => {
    const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
      {expressId:7,type:'IfcBeam',hasGeometry:true},
      {expressId:8,type:'IfcPropertySet',hasGeometry:false},
    ]});
    const models = new Map(Array.from({length:count},(_,i)=>{
      const id = `m${i}`;
      return [id,{...fixtureModel(id,{idOffset:count === 1 ? 0 : (i+1)*1_000_000}),ifcDataStore:store}];
    }));
    const views = new Map<string,MutablePropertyView>();
    const state = {models,ifcDataStore:store,mutationViews:views,hiddenEntities:new Set<number>(),
      typeVisibility:{...TYPE_VISIBILITY_SEMANTIC_DEFAULTS},
      toGlobalId:(modelId:string,id:number)=>toGlobalIdFromModels(models,modelId,id)};
    assert.equal(hasStructuralData(state),false);
    const modelId = `m${count-1}`;
    const view = new MutablePropertyView(null,modelId);
    views.set(modelId,view);
    const editor = new StoreEditor(store,view);
    const physical = editor.addEntity('IfcBeam',[generateIfcGuid(),null,'New beam',null,null,null,null,null,null]);
    const analytical = editor.addEntity('IfcStructuralPointConnection',[generateIfcGuid(),null,'New joint',null,null,null,null,null,null]);
    assert.equal(hasStructuralData(state),true,'authored analytical data enables the command');
    const physicalMode = {...state,typeVisibility:{...state.typeVisibility,structuralViewMode:'physical' as const}};
    const hiddenPhysical = resolveViewHiddenEntities(physicalMode);
    assert.equal(hiddenPhysical.has(state.toGlobalId(modelId,analytical.expressId)),true);
    assert.equal(hiddenPhysical.has(state.toGlobalId(modelId,physical.expressId)),false);
    const analyticalMode = {...state,typeVisibility:{...state.typeVisibility,structuralViewMode:'analytical' as const}};
    const hiddenAnalytical = resolveViewHiddenEntities(analyticalMode);
    assert.equal(hiddenAnalytical.has(state.toGlobalId(modelId,physical.expressId)),true);
    assert.equal(hiddenAnalytical.has(state.toGlobalId(modelId,analytical.expressId)),false);
    assert.ok([...models.keys()].every((id)=>hiddenAnalytical.has(state.toGlobalId(id,7))));
    assert.ok([...models.keys()].every((id)=>!hiddenAnalytical.has(state.toGlobalId(id,8))),
      'analytical mode leaves property resources available for the visible products');
    // Saved scene/cache ownership must distinguish the product mode and survive JSON storage.
    const restored = JSON.parse(JSON.stringify(physicalMode.typeVisibility));
    assert.notEqual(sceneSnapshotKey('p','model',restored),sceneSnapshotKey('p','model',state.typeVisibility));
    assert.equal(structuralGlyphsVisible(restored),false);
  });
}
