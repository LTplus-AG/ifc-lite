/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcCreator } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { asRef, refList } from '../../../../../packages/create/src/in-store/style-entity-reader.js';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID } from '@/test/modeling-session-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { createStoreAdapter } from './store-adapter';
import { loadStoreyAdapter } from './store-adapter-storey';

function assertRelationshipReferences(output: Uint8Array): string {
  const text = new TextDecoder().decode(output);
  const ids = new Set([...text.matchAll(/^#(\d+)=/gm)].map(match => Number(match[1])));
  const relationships = text.split('\n').filter(line => line.includes('=IFCRELDEFINESBYPROPERTIES('));
  assert.ok(relationships.length > 0);
  for (const line of relationships) for (const match of line.matchAll(/#(\d+)/g)) {
    assert.ok(ids.has(Number(match[1])), `Missing relationship reference: ${line}`);
  }
  return text;
}

it('#9296 reopened typed floor keeps property definitions and one relationship per type',async t=>{
  if (!ensureRoomWasm(t)) return;
  const c=new IfcCreator(), ground=c.addIfcBuildingStorey({Name:'Level 1',Elevation:0}), upper=c.addIfcBuildingStorey({Name:'Level 2',Elevation:3});
  await seedModelingSession({step:c.toIfc().content});await loadStoreyAdapter();
  const adapter=createStoreAdapter(useViewerStore), M=MODEL_ID;
  const type=adapter.addElementType!(M,{Type:'IfcWallType',Name:'WT-230',PredefinedType:'STANDARD'});
  const layers=[['Masonry',.115],['Insulation',.100],['Finish',.015]] as const;
  const materials=layers.map(([Name])=>adapter.addMaterial!(M,{Name}));
  const set=adapter.addMaterialLayerSet!(M,{MaterialLayers:layers.map(([,LayerThickness],i)=>({Material:materials[i].expressId,LayerThickness}))});
  adapter.assignMaterial!(M,set.expressId,[type.expressId]);
  const walls=([[0,0,10,0],[10,0,10,8],[10,8,0,8],[0,8,0,0],[5,0,5,8]]).map(([x,y,ex,ey])=>adapter.addWall(M,ground,{Start:[x,y,0],End:[ex,ey,0],Thickness:.23,Height:3}));
  adapter.assignType!(M,type.expressId,walls.map(w=>w.expressId));
  adapter.addHostedDoor(M,walls[0].expressId,{Offset:2.5,Width:.9,Height:2.1});
  adapter.addHostedWindow(M,walls[2].expressId,{Offset:2.5,Width:1.2,Height:1.2,Sill:.9});
  adapter.addSlab(M,ground,{Position:[0,0,0],Width:10,Depth:8,Thickness:.2});
  const generated=useViewerStore.getState().generateSpacesFromWalls(M,ground);assert.ok(!('error' in generated));assert.equal(generated.emitted.length,2);
  const authoredView=useViewerStore.getState().mutationViews.get(M)!;
  configureMutationView(authoredView,useViewerStore.getState().models.get(M)!.ifcDataStore!);
  for (const wall of walls) {
    const quantities=authoredView.getQuantitiesForEntity(wall.expressId).find(set=>set.name==='Qto_WallBaseQuantities');
    assert.ok(quantities && quantities.quantities.length>0);
    useViewerStore.getState().createQuantitySet(M,wall.expressId,quantities.name,
      quantities.quantities.map(quantity=>({name:quantity.name,value:quantity.value,quantityType:quantity.type,unit:quantity.unit})));
  }
  const save=()=>{const s=useViewerStore.getState();return new StepExporter(s.models.get(M)!.ifcDataStore!,s.mutationViews.get(M)!).export({schema:'IFC4',applyMutations:true}).content;};
  const saved=save();await seedModelingSession({step:new TextDecoder().decode(saved)});
  const source=useViewerStore.getState().models.get(M)!.ifcDataStore!,view=useViewerStore.getState().mutationViews.get(M)!;configureMutationView(view,source);
  assert.ok(useViewerStore.getState().setEntityPosition(M,walls[4].expressId,[6,0,0]).ok);assertRelationshipReferences(save());
  const fresh=createStoreAdapter(useViewerStore);
  const third=fresh.addStorey!(M,{Name:'Level 3',Elevation:6});
  const copied=fresh.copyElements!(M,walls.slice(0,4).map(w=>w.expressId),[{targetStoreyId:upper}]);
  assertRelationshipReferences(save());
  const second=fresh.copyElements!(M,copied.map(r=>r.expressId),[{targetStoreyId:third.expressId}]);
  const output=save();
  const text=assertRelationshipReferences(output);
  // Check type cardinality separately from property-definition reachability.
  const reopened=await new IfcParser().parseColumnar(output.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
  const reader=new AnchorEntityReader(reopened,null);
  const quantities=(id:number)=>{
    const sets=extractQuantitiesOnDemand(reopened,id).filter(set=>set.name==='Qto_WallBaseQuantities');
    assert.equal(sets.length,1,'one saved quantity set per wall');
    return Object.fromEntries(sets[0].quantities.map(quantity=>[quantity.name,quantity.value]));
  };
  for (let i=0;i<copied.length;i++) {
    assert.deepEqual(quantities(copied[i].expressId),quantities(walls[i].expressId));
    assert.deepEqual(quantities(second[i].expressId),quantities(walls[i].expressId));
  }
  for (const recordType of ['IFCPROPERTYSET','IFCELEMENTQUANTITY','IFCRELDEFINESBYPROPERTIES']) {
    const guids=[...reader.ids(recordType)].map(id=>reader.entity(id)!.attributes[0]);
    assert.equal(new Set(guids).size,guids.length,`${recordType} GlobalIds are unique`);
  }
  const relationships=[...reader.ids('IFCRELDEFINESBYTYPE')].map(id=>reader.entity(id)!);
  for (const [typeClass,productClass] of [['IFCWALLTYPE','IFCWALL'],['IFCDOORTYPE','IFCDOOR'],['IFCWINDOWTYPE','IFCWINDOW']] as const) {
    const types=[...reader.ids(typeClass)];assert.equal(types.length,1,`${typeClass} is present`);
    const own=relationships.filter(rel=>asRef(rel.attributes[5])===types[0]);
    assert.equal(own.length,1,`${typeClass} has one relationship`);
    assert.deepEqual(refList(own[0].attributes[4]).sort((a,b)=>a-b),[...reader.ids(productClass)].sort((a,b)=>a-b),
      `${typeClass} covers original and copied occurrences`);
  }
  for(const [type,count] of [['IFCWALL',13],['IFCDOOR',3],['IFCWINDOW',3],['IFCOPENINGELEMENT',6],['IFCSLAB',1],['IFCSPACE',2]] as const) assert.equal(text.split('='+type+'(').length-1,count);

});
