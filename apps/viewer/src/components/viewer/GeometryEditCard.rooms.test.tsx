/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it, afterEach } from 'node:test';
import { act } from 'react';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcAPI } from '@ifc-lite/wasm';
import { remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { ensureRoomWasm, authoredSpaces, wallMesh, type Wall } from '@/test/room-walls-fixture';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { render, cleanup, click, type as typeInto } from '@/test/render';
import { GeometryEditCard } from './GeometryEditCard';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import '@/lib/commands/modeling/builtin';

afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); });
it('#9296 inspector wall movement updates reopened generated spaces and undo restores areas', async t => {
  await seedModelingSession();
  if (!ensureRoomWasm(t)) return;
  await ensureSpaceWasm();
  const restore = setRequestRemesh(() => {});
  try {
    useViewerStore.getState().mutationViews.get(MODEL_ID)!.deleteEntity(130);
    const walls: Wall[] = [[[0,0],[10,0]],[[10,0],[10,8]],[[10,8],[0,8]],[[0,8],[0,0]],[[5,0],[5,8]]];
    const ids=walls.map(([a,b])=>{
      const result=useViewerStore.getState().addWall(MODEL_ID,STOREY,{Start:[...a,0],End:[...b,0],Height:3,Thickness:.23});
      assert.ok('expressId' in result);return result.expressId;
    });
    const state=useViewerStore.getState(),model=state.models.get(MODEL_ID)!;
    const geometryResult={...model.geometryResult!,meshes:walls.map(([a,b],i)=>wallMesh(ids[i],a,b,0,3,.23))};
    useViewerStore.setState({models:new Map([[MODEL_ID,{...model,geometryResult}]]),geometryResult});
    useViewerStore.getState().startCommand('room.place');
    for(const local of [[2.5,4],[7.5,4]] as [number,number][]) act(()=>{
      const snap={local,winner:null,guides:[],locked:false};commandPointerMove(snap);commandPointerDown(snap);
    });
    const rooms=authoredSpaces();assert.equal(rooms.length,2);
    const bytes=new StepExporter(model.ifcDataStore!,useViewerStore.getState().mutationViews.get(MODEL_ID)!).export({schema:'IFC4',applyMutations:true}).content;
    // Discard every live overlay and parse the saved file into a fresh session.
    useViewerStore.getState().exitModelWorkspace();
    await seedModelingSession();
    const data=await new IfcParser().parseColumnar(bytes.slice().buffer,{disableWorkerScan:true});
    const view=new MutablePropertyView(data.properties??null,MODEL_ID);configureMutationView(view,data);
    const fresh=useViewerStore.getState().models.get(MODEL_ID)!;
    useViewerStore.setState({models:new Map([[MODEL_ID,{...fresh,ifcDataStore:data}]]),ifcDataStore:data,mutationViews:new Map([[MODEL_ID,view]]),storeEditors:new Map(),undoStacks:new Map(),redoStacks:new Map()});
    useViewerStore.getState().enterModelWorkspace();
    const area=(id:number)=>view.getQuantitiesForEntity(id).find(q=>q.name==='Qto_SpaceBaseQuantities')?.quantities.find(q=>q.name==='NetFloorArea')?.value;
    for (const room of rooms) assert.equal(data.entities.getGlobalId(room.id),room.guid);
    const before=rooms.map(r=>area(r.id));assert.ok(before.every(a=>typeof a==='number'));
    const ui=render(<GeometryEditCard modelId={MODEL_ID} entityId={ids[4]} />);
    const x=ui.querySelector<HTMLInputElement>('input[type="number"]');assert.ok(x);typeInto(x,'6');
    const apply=[...ui.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Apply XYZ');assert.ok(apply);click(apply);
    const after=rooms.map(r=>area(r.id));
    assert.deepEqual(after.map(a=>Math.round(Number(a)*10000)).sort((a,b)=>a-b),[292929,448329]);
    assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID,ids[4])![0],6);
    const exported=new StepExporter(data,view).export({schema:'IFC4',applyMutations:true}).content;
    const reopened=await new IfcParser().parseColumnar(exported.slice().buffer,{disableWorkerScan:true});
    assert.notDeepEqual(rooms.map(r=>extractQuantitiesOnDemand(reopened,r.id).find(q=>q.name==='Qto_SpaceBaseQuantities')?.quantities.find(q=>q.name==='NetFloorArea')?.value),before);
    const api = new IfcAPI();
    try {
      const meshed = remeshOnApi(api,{...styleWireOnApi(api,exported),buffer:exported,targets:Uint32Array.from(rooms.map(r=>r.id)),frame:{x:0,y:0,z:0,needsShift:false}});
      for (let i=0;i<rooms.length;i++) {
        const positions=meshed.meshes.filter(m=>m.expressId===rooms[i].id).flatMap(m=>Array.from(m.positions));
        assert.ok(positions.length>0,'saved room has geometry');
        const xs=positions.filter((_,n)=>n%3===0),zs=positions.filter((_,n)=>n%3===2);
        const meshArea=(Math.max(...xs)-Math.min(...xs))*(Math.max(...zs)-Math.min(...zs));
        assert.ok(Math.abs(meshArea-Number(after[i]))<1e-4,'exported room mesh and area agree');
      }
    } finally {api.free();}
    useViewerStore.getState().undo(MODEL_ID);assert.deepEqual(rooms.map(r=>area(r.id)),before);
    assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID,ids[4])![0],5);
    useViewerStore.getState().redo(MODEL_ID);assert.deepEqual(rooms.map(r=>area(r.id)),after);
    assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID,ids[4])![0],6);
  } finally {restore();}
});
