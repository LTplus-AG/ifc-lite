/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/lib/commands/modeling/builtin';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { getCompleteEntityIndex } from '../../../../../packages/export/src/entity-iteration.js';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL, settle, nativeSdkMeshes } from '@/test/native-sdk-model';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { runRoomAction } from '@/components/viewer/tools/command/RoomPlaceBar';
import { parseRoomProposal } from './room-command-proposal';
const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); setRemeshClientFactory(null); clearStoreyRoomsCache(); clearModelLayouts(MODEL); useViewerStore.setState(initial, true); });

it('audit: actual Bonsai IFC4 + canonical wall WASM supports native AutoAll on two current storeys in one Undo group', async t => {
  if (!ensureRoomWasm(t)) return;
  const { store, view, adapter } = await seedReviewedRoom();
  const editor = modelEditTarget(useViewerStore.getState(), MODEL)!.editor;
  const point = editor.addEntity('IfcCartesianPoint', [[0,0,3]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`,null,null]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [null,`#${axis}`]).expressId;
  const upper = editor.addEntity('IfcBuildingStorey', ['0Storey000000000000005',null,'Audit upper',null,null,`#${placement}`,null,null,'.ELEMENT.',3]).expressId;
  const points: [number,number,number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  for (const [i,Start] of points.entries()) adapter.addWall(MODEL, upper, { Start, End:points[(i+1)%4], Thickness:.2, Height:3 });
  await settle();
  assert.equal(modelStoreys(useViewerStore.getState(),MODEL).length,2);
  assert.ok(nativeSdkMeshes().filter(m=>m.ifcType==='IfcWall').length>=8, 'actual native writer bodies were remeshed, not supplied mesh results');
  const before = structuredClone(view.getEffectiveChanges());
  const priorSpaces = new Set(view.getNewEntities().filter(e=>e.type.toUpperCase()==='IFCSPACE').map(e=>e.expressId));
  const undoBefore = useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;
  assert.equal(useViewerStore.getState().enterModelWorkspace({ modelId:MODEL, storeyId:42 }),true);
  useViewerStore.getState().startCommand('room.place');
  await act(async()=> { await runRoomAction('autoAll'); });
  const spaces = view.getNewEntities().filter(e=>e.type.toUpperCase()==='IFCSPACE' && !view.isDeleted(e.expressId) && !priorSpaces.has(e.expressId));
  assert.equal(spaces.length,2, 'the two independently closed native 4x3 wall loops each produce one unoccupied space');
  const bytes = new StepExporter(store,view).export({schema:'IFC4',applyMutations:true}).content;
  const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
  const extractor = new EntityExtractor(parsed.source);
  const rows = [...getCompleteEntityIndex(parsed)].map(([expressId,loc])=>extractor.extractEntity({...loc,expressId,lineNumber:0})!).filter(Boolean);
  const owners = spaces.map(space=>rows.find(e=>e.type==='IFCRELAGGREGATES' && Array.isArray(e.attributes[5]) && e.attributes[5].includes(space.expressId))?.attributes[4]);
  assert.deepEqual(owners.sort(), [42,upper].sort(), 'independently reparsed IFC retains actual storey owners');
  await settle();
  for (const space of spaces) assert.ok(nativeSdkMeshes().some(m=>m.expressId===space.expressId && m.indices.length>0));
  useViewerStore.getState().undo(MODEL); await settle();
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length,undoBefore);
  assert.deepEqual(view.getEffectiveChanges(),before,'one native Undo reverses both storeys');
});

it('audit missing route: public reviewed Room parser should represent the existing explicit AutoAll intent', async t => {
  if (!ensureRoomWasm(t)) return;
  await seedReviewedRoom();
  const envelope = roomEnvelope({action:'autoAll'});
  assert.doesNotThrow(()=>parseRoomProposal(JSON.stringify(envelope)), 'existing Room command cannot carry native AutoAll intent');
});
