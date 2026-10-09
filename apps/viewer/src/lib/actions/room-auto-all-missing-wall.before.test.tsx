/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/lib/commands/modeling/builtin';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { seedReviewedRoom, roomProposal } from '@/test/reviewed-room-fixture';
import { MODEL, seedNativeSdkModel, settle, nativeSdkMeshes } from '@/test/native-sdk-model';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { prepareRoomReview } from './room-review';

const initial = useViewerStore.getState();
afterEach(() => {
  setRemeshClientFactory(null); clearStoreyRoomsCache(); clearModelLayouts(MODEL);
  useViewerStore.setState(initial, true);
});
const points: [number,number,number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];

for (const mixed of [false, true]) test(`#7324 native AutoAll refuses live contained walls without Representation${mixed ? ' across a mixed storey population' : ''}`, async t => {
  if (!ensureRoomWasm(t)) return;
  const native = await seedReviewedRoom();
  const editor = modelEditTarget(useViewerStore.getState(), MODEL)!.editor;
  let owner = 42;
  if (mixed) {
    const point = editor.addEntity('IfcCartesianPoint', [[0,0,3]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`,null,null]).expressId;
    const placement = editor.addEntity('IfcLocalPlacement', [null,`#${axis}`]).expressId;
    owner = editor.addEntity('IfcBuildingStorey', ['0Storey000000000000005',null,'Missing wall geometry',null,null,`#${placement}`,null,null,'.ELEMENT.',3]).expressId;
    for (const [i, Start] of points.entries()) native.adapter.addWall(MODEL, owner, { Start, End: points[(i+1)%4], Thickness:.2, Height:3 });
    await settle();
  }
  const walls = [...iterateEffectiveEntities(native.store, native.view, ['IfcWall','IfcWallStandardCase'])]
    .filter(row => native.view.getNewEntity(row.expressId)).map(row => row.expressId);
  const missing = mixed ? walls.slice(-4) : walls;
  assert.equal(missing.length, 4, 'four actual native authored walls retain their Root and containment');
  for (const id of missing) native.view.setPositionalAttribute(id, 6, null);
  const bytes = new StepExporter(native.store,native.view).export({ schema:'IFC4',applyMutations:true }).content;
  const reloaded = await seedNativeSdkModel(bytes);
  for (const id of missing) {
    const record = effectiveMetadataRecord(reloaded.store,id,reloaded.view); assert.ok(record);
    assert.equal(record.type.toUpperCase(),'IFCWALL');
    assert.equal(record.attributes[6],null,'independent native export/reload preserves the absent optional Representation');
  }
  const containment = [...iterateEffectiveEntities(reloaded.store,reloaded.view,['IfcRelContainedInSpatialStructure'])]
    .map(row => effectiveMetadataRecord(reloaded.store,row.expressId,reloaded.view)).filter(row => row?.attributes[5] === owner);
  assert.ok(missing.every(id => containment.some(row => Array.isArray(row?.attributes[4]) && row.attributes[4].includes(id))), 'actual source containment still assigns every live wall to the target storey');
  const remesh = await requestRemesh(useViewerStore.getState,MODEL,walls,'shape');
  assert.equal(remesh.status,'applied','BEFORE setup requires actual successful canonical WASM remesh; an earlier native refusal is a separate control');
  assert.ok(missing.every(id => !nativeSdkMeshes().some(mesh => mesh.expressId === id && mesh.positions.length && mesh.indices.length)), 'canonical native producer supplies no usable geometry for these actual live walls');
  const before = structuredClone(reloaded.view.getEffectiveChanges());
  const count = reloaded.view.getNewEntities().length;
  const undo = useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;
  const review = await prepareRoomReview(roomProposal({ action:'autoAll' }),new AbortController().signal);
  try {
    const coverage = review.snapshot.storeys?.find(row => row.expressId === owner); assert.ok(coverage);
    assert.equal(coverage.status,'unavailable','live walls with missing native geometry cannot be classified as a genuinely wall-free storey');
    assert.equal(review.prepared.result.created.length,0,'complete AutoAll cannot prepare a lower-storey partial write');
    assert.throws(() => review.commit(),/unavailable|geometry|coverage/i);
  } finally { review.dispose(); }
  assert.deepEqual(reloaded.view.getEffectiveChanges(),before);
  assert.equal(reloaded.view.getNewEntities().length,count,'refusal preserves allocation');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0,undo);
});

test('#7324 genuine wall-free upper storey remains noWalls alongside the native enclosed lower storey',async t => {
  if (!ensureRoomWasm(t)) return;
  const native = await seedReviewedRoom();
  const editor = modelEditTarget(useViewerStore.getState(),MODEL)!.editor;
  const point = editor.addEntity('IfcCartesianPoint',[[0,0,3]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D',[`#${point}`,null,null]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement',[null,`#${axis}`]).expressId;
  const upper = editor.addEntity('IfcBuildingStorey',['0Storey000000000000005',null,'Genuinely empty upper',null,null,`#${placement}`,null,null,'.ELEMENT.',3]).expressId;
  const before = structuredClone(native.view.getEffectiveChanges());
  const review = await prepareRoomReview(roomProposal({action:'autoAll'}),new AbortController().signal);
  try {
    assert.equal(review.snapshot.storeys?.find(row => row.expressId === upper)?.status,'noWalls');
    assert.equal(review.prepared.result.created.length,1,'actual canonical lower wall loop remains supported');
    assert.equal(review.commit().created.length,1);
    useViewerStore.getState().undo(MODEL); await settle();
    assert.deepEqual(native.view.getEffectiveChanges(),before,'one native Undo restores the pre-approval graph');
  } finally { review.dispose(); }
});
