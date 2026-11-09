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
import { resolveRotationState } from '@/lib/placement-edit';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import '@/lib/commands/modeling/builtin';

afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); });
for (const operation of ['move', 'rotate', 'rotate-implicit'] as const) it(`#9296 inspector ${operation} updates reopened generated spaces and undo restores areas`, async t => {
  await seedModelingSession();
  if (!ensureRoomWasm(t)) return;
  await ensureSpaceWasm();
  const restore = setRequestRemesh(() => {});
  try {
    useViewerStore.getState().mutationViews.get(MODEL_ID)!.deleteEntity(130);
    const walls: Wall[] = [[[0,0],[10,0]],[[10,0],[10,8]],[[10,8],[0,8]],[[0,8],[0,0]],operation === 'rotate-implicit' ? [[-1,4],[11,4]] : [[5,-1],[5,9]]];
    const ids=walls.map(([a,b])=>{
      const result=useViewerStore.getState().addWall(MODEL_ID,STOREY,{Start:[...a,0],End:[...b,0],Height:3,Thickness:.23});
      assert.ok('expressId' in result);return result.expressId;
    });
    const state=useViewerStore.getState(),model=state.models.get(MODEL_ID)!;
    if (operation === 'rotate-implicit') {
      const editor=state.storeEditors.get(MODEL_ID)!;
      const rotation=resolveRotationState(model.ifcDataStore!,editor.getMutationView(),editor,ids[4])!;
      state.setPositionalAttribute(MODEL_ID,rotation.axisPlacementId,2,null);
    }
    const geometryResult={...model.geometryResult!,meshes:walls.map(([a,b],i)=>wallMesh(ids[i],a,b,0,3,.23))};
    useViewerStore.setState({models:new Map([[MODEL_ID,{...model,geometryResult}]]),geometryResult});
    useViewerStore.getState().startCommand('room.place');
    for(const local of (operation === 'rotate-implicit' ? [[2.5,2],[7.5,6]] : [[2.5,4],[7.5,4]]) as [number,number][]) act(()=>{
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
    const yawBefore=useViewerStore.getState().readEntityRotation(MODEL_ID,ids[4])!.yawZ;
    const before=rooms.map(r=>area(r.id));assert.ok(before.every(a=>typeof a==='number'));
    const ui=render(<GeometryEditCard modelId={MODEL_ID} entityId={ids[4]} />);
    const x=ui.querySelector<HTMLInputElement>('input[type="number"]');assert.ok(x);
    if (operation === 'move') typeInto(x,'6');
    const apply=[...ui.querySelectorAll('button')].find(b=>operation === 'move' ? b.textContent?.trim()==='Apply XYZ' : b.getAttribute('aria-label')==='Rotate +15°');assert.ok(apply);click(apply);
    const after=rooms.map(r=>area(r.id));
    assert.ok(Math.abs(useViewerStore.getState().readEntityRotation(MODEL_ID,ids[4])!.yawZ-yawBefore-(operation === 'move' ? 0 : Math.PI/12))<1e-8);
    const theta=Math.PI/12, half=.115/Math.cos(theta);
    const expected=operation === 'move' ? [29.2929,44.8329] : operation === 'rotate'
      ? [(5-5*Math.tan(theta)-.115-half)*7.77,(9.885-(5-5*Math.tan(theta))-half)*7.77]
      : [(4+6*Math.tan(theta)-.115-half)*9.77,(7.885-(4+6*Math.tan(theta))-half)*9.77];
    assert.deepEqual(after.map(a=>Math.round(Number(a)*10000)).sort((a,b)=>a-b),expected.map(a=>Math.round(a*10000)).sort((a,b)=>a-b));
    const exported=new StepExporter(data,view).export({schema:'IFC4',applyMutations:true}).content;
    const reopened=await new IfcParser().parseColumnar(exported.slice().buffer,{disableWorkerScan:true});
    assert.notDeepEqual(rooms.map(r=>extractQuantitiesOnDemand(reopened,r.id).find(q=>q.name==='Qto_SpaceBaseQuantities')?.quantities.find(q=>q.name==='NetFloorArea')?.value),before);
    const assertMeshAreas = (content: Uint8Array, areas: typeof after) => {
    const api = new IfcAPI();
    try {
      const meshed = remeshOnApi(api,{...styleWireOnApi(api,content),buffer:content,targets:Uint32Array.from(rooms.map(r=>r.id)),frame:{x:0,y:0,z:0,needsShift:false}});
      for (let i=0;i<rooms.length;i++) {
        const meshes=meshed.meshes.filter(m=>m.expressId===rooms[i].id);
        assert.ok(meshes.length>0,'saved room has geometry');
        const top=Math.max(...meshes.flatMap(m=>Array.from(m.positions).filter((_,n)=>n%3===1)));
        let meshArea=0;
        for (const mesh of meshes) for(let n=0;n<mesh.indices.length;n+=3) {
          const [a,b,c]=[mesh.indices[n],mesh.indices[n+1],mesh.indices[n+2]].map(i=>Array.from(mesh.positions.slice(i*3,i*3+3)));
          if ([a,b,c].every(p=>Math.abs(p[1]-top)<1e-5)) meshArea+=Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2;
        }
        assert.ok(Math.abs(meshArea-Number(areas[i]))<1e-4,'exported room mesh and area agree');
      }
    } finally {api.free();}
    };
    assertMeshAreas(exported,after);
    act(()=>useViewerStore.getState().undo(MODEL_ID));assert.deepEqual(rooms.map(r=>area(r.id)),before);
    assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID,ids[4])![0],operation === 'rotate-implicit' ? -1 : 5);
    assert.ok(Math.abs(useViewerStore.getState().readEntityRotation(MODEL_ID,ids[4])!.yawZ-yawBefore)<1e-8);
    assertMeshAreas(new StepExporter(data,view).export({schema:'IFC4',applyMutations:true}).content,before);
    act(()=>useViewerStore.getState().redo(MODEL_ID));assert.deepEqual(rooms.map(r=>area(r.id)),after);
    if (operation === 'move') assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID,ids[4])![0],6);
  } finally {restore();}
});
