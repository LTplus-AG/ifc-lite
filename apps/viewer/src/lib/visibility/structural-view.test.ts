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
import { hasStructuralData, isAnalyticalProduct, resolveViewHiddenEntities, structuralGlyphsVisible } from './structural-view';
import { useViewerStore } from '@/store';
import { resolveExportVisibility } from '@/store/exportVisibility';
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
      typeVisibility:{...TYPE_VISIBILITY_SEMANTIC_DEFAULTS},structuralViewMode:'both' as const,
      toGlobalId:(modelId:string,id:number)=>toGlobalIdFromModels(models,modelId,id)};
    assert.equal(hasStructuralData(state),false);
    const modelId = `m${count-1}`;
    const view = new MutablePropertyView(null,modelId);
    views.set(modelId,view);
    const editor = new StoreEditor(store,view);
    const physical = editor.addEntity('IfcBeam',[generateIfcGuid(),null,'New beam',null,null,null,null,null,null]);
    const analytical = editor.addEntity('IfcStructuralPointConnection',[generateIfcGuid(),null,'New joint',null,null,null,null,null,null]);
    assert.equal(hasStructuralData(state),true,'authored analytical data enables the command');
    const physicalMode = {...state,structuralViewMode:'physical' as const};
    const hiddenPhysical = resolveViewHiddenEntities(physicalMode);
    assert.equal(hiddenPhysical.has(state.toGlobalId(modelId,analytical.expressId)),true);
    assert.equal(hiddenPhysical.has(state.toGlobalId(modelId,physical.expressId)),false);
    const analyticalMode = {...state,structuralViewMode:'analytical' as const};
    const hiddenAnalytical = resolveViewHiddenEntities(analyticalMode);
    assert.equal(hiddenAnalytical.has(state.toGlobalId(modelId,physical.expressId)),true);
    assert.equal(hiddenAnalytical.has(state.toGlobalId(modelId,analytical.expressId)),false);
    assert.ok([...models.keys()].every((id)=>hiddenAnalytical.has(state.toGlobalId(id,7))));
    assert.ok([...models.keys()].every((id)=>!hiddenAnalytical.has(state.toGlobalId(id,8))),
      'analytical mode leaves property resources available for the visible products');
    // Saved scene/cache ownership must distinguish the product mode and survive JSON storage.
    const restored = JSON.parse(JSON.stringify({typeVisibility:physicalMode.typeVisibility,structuralViewMode:physicalMode.structuralViewMode}));
    assert.notEqual(sceneSnapshotKey('p','model',restored.typeVisibility,restored.structuralViewMode),sceneSnapshotKey('p','model',state.typeVisibility));
    assert.equal(structuralGlyphsVisible(restored.typeVisibility,restored.structuralViewMode),false);
  });
}

it('#9923: retyping a physical product to an analytical class enables the mode command', () => {
  const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
    {expressId:7,type:'IfcBeam',hasGeometry:true},
  ]});
  const view = new MutablePropertyView(null,'__legacy__');
  const state = {models:new Map(),ifcDataStore:store,mutationViews:new Map([['__legacy__',view]])};
  assert.equal(hasStructuralData(state),false);
  new StoreEditor(store,view).setEntityType(7,'IfcStructuralCurveMember');
  assert.equal(hasStructuralData(state),true,'the mask and the command agree on a retyped product');
});

it('#9923: retyping the only analytical product away disables the mode command', () => {
  const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
    {expressId:7,type:'IfcStructuralCurveMember',hasGeometry:true},
  ]});
  const view = new MutablePropertyView(null,'__legacy__');
  const state = {models:new Map(),ifcDataStore:store,mutationViews:new Map([['__legacy__',view]])};
  assert.equal(hasStructuralData(state),true);
  new StoreEditor(store,view).setEntityType(7,'IfcBeam');
  assert.equal(hasStructuralData(state),false,'the index still lists the original class, the effective model does not');
});

it('#9923: deleting the only analytical product disables the mode command', () => {
  const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
    {expressId:7,type:'IfcStructuralCurveMember',hasGeometry:true},
  ]});
  const view = new MutablePropertyView(null,'__legacy__');
  const state = {models:new Map(),ifcDataStore:store,mutationViews:new Map([['__legacy__',view]])};
  assert.equal(hasStructuralData(state),true);
  new StoreEditor(store,view).removeEntity(7);
  assert.equal(hasStructuralData(state),false,'the index still lists the deleted entity, the effective model does not');
});

it('#9923: the mask reads a retype of a newly authored entity', () => {
  const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[]});
  const view = new MutablePropertyView(null,'__legacy__');
  const editor = new StoreEditor(store,view);
  const beam = editor.addEntity('IfcBeam',[generateIfcGuid(),null,'New beam',null,null,null,null,null,null]);
  editor.setEntityType(beam.expressId,'IfcStructuralCurveMember');
  const state = {models:new Map(),ifcDataStore:store,mutationViews:new Map([['__legacy__',view]]),
    hiddenEntities:new Set<number>(),toGlobalId:(_m:string,id:number)=>id};
  assert.equal(hasStructuralData(state),true);
  assert.equal(resolveViewHiddenEntities({...state,structuralViewMode:'physical'}).has(beam.expressId),true);
  assert.equal(resolveViewHiddenEntities({...state,structuralViewMode:'analytical'}).has(beam.expressId),false);
});

for (const edit of ['retype','delete'] as const) {
  it(`#9923: presence and mask agree after a ${edit} in a federated model and in legacy mode`, () => {
    for (const federated of [true,false]) {
      const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
        {expressId:7,type:'IfcStructuralCurveMember',hasGeometry:true},
        {expressId:9,type:'IfcBeam',hasGeometry:true},
      ]});
      const key = federated ? 'm0' : '__legacy__';
      const models = federated ? new Map([[key,{...fixtureModel(key,{idOffset:0}),ifcDataStore:store}]]) : new Map();
      const view = new MutablePropertyView(null,key);
      const state = {models,ifcDataStore:federated ? null : store,mutationViews:new Map([[key,view]]),
        hiddenEntities:new Set<number>(),toGlobalId:(m:string,id:number)=>toGlobalIdFromModels(models,m,id)};
      const editor = new StoreEditor(store,view);
      if (edit === 'retype') editor.setEntityType(7,'IfcBeam'); else editor.removeEntity(7);
      assert.equal(hasStructuralData(state),false,`${edit}, federated=${federated}`);
      const id7 = state.toGlobalId(key,7);
      // A retyped beam is physical now, so physical mode shows it. A deleted member keeps its parsed
      // class in the mask, so its mesh stays hidden there until the rebuild drops it.
      assert.equal(resolveViewHiddenEntities({...state,structuralViewMode:'physical'}).has(id7),edit === 'delete',`${edit}, federated=${federated}`);
      if (edit === 'retype') {
        assert.equal(resolveViewHiddenEntities({...state,structuralViewMode:'analytical'}).has(id7),true,`${edit}, federated=${federated}`);
      }
    }
  });
}

it('#9923: IFC2X3 varying actions are analytical', () => {
  for (const type of ['IfcStructuralLinearActionVarying','IfcStructuralPlanarActionVarying']) {
    assert.equal(isAnalyticalProduct(type),true,type);
  }
  assert.equal(isAnalyticalProduct('IfcStructuralSurfaceMemberVarying'),true);
  assert.equal(isAnalyticalProduct('IfcStructuralLoadGroup'),false);
});

it('#9923: both preserves main export visibility for a hidden model', () => {
  const store = createSyntheticDataStore({schemaVersion:'IFC4',fileSize:0,entities:[
    {expressId:7,type:'IfcBeam',hasGeometry:true},
    {expressId:9,type:'IfcBeam',hasGeometry:true},
    {expressId:10,type:'IfcColumn',hasGeometry:true},
    {expressId:11,type:'IfcStructuralPointConnection',hasGeometry:true},
  ]});
  const models = new Map(['a','b'].map((id,i)=>[id,{
    ...fixtureModel(id,{idOffset:(i+1)*1_000_000}),ifcDataStore:store,maxExpressId:11,visible:id==='a',
  }]));
  const state = {...useViewerStore.getState(),models,mutationViews:new Map<string,MutablePropertyView>(),
    hiddenEntities:new Set<number>(),isolatedEntities:null,classFilter:null,selectedStoreys:new Set<number>(),
    lensHiddenIds:new Set<number>(),typeVisibility:{...TYPE_VISIBILITY_SEMANTIC_DEFAULTS},structuralViewMode:'both' as const,
    toGlobalId:(modelId:string,id:number)=>toGlobalIdFromModels(models,modelId,id)};
  assert.equal(resolveViewHiddenEntities(state),state.hiddenEntities,'both is the exact existing hide channel');
  assert.deepEqual([...resolveExportVisibility(state,'b').hiddenLocalIds],[],
    'main does not convert a hidden model flag into explicit hidden export products');
  const physical = {...state,structuralViewMode:'physical' as const};
  assert.deepEqual([...resolveExportVisibility(physical,'b').hiddenLocalIds],[11],
    'only the analytical product mask is added in physical mode');
});
