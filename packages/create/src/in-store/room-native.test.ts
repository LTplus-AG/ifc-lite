/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { readFaces, flattenRoomRects, applyLayoutOp, type RoomPlate, type Pt } from './room-layout-core.js';
import { roomCandidatesFromFaces, occupancyTest } from './room-candidates.js';
import { existingSpaceFootprintEntriesByStorey } from './space-footprints.js';
import { planRoomCreation } from './room-creation-plan.js';
import { storeyFootprintFaceInStore } from './room-footprint-native.js';
import { createRoomsInStore, syncRoomLayoutInStore, updateRoomOutlineInStore, roomChainInStore } from './room-store.js';

// #6232 D5 invariant: a native DCEL rectangle split partitions its original
// room area; writing it into a real Bonsai storey preserves root identity.
const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasm);
const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
let fromRects: (rects: Float64Array, weld: number, min: number) => RoomPlate;
beforeAll(async () => {
  if (!available) { console.warn('Room native controls require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
  fromRects = (rects, weld, min) => runtime.SpacePlateHandle.fromWallRects(rects, weld, min);
});
const rects: Pt[][] = [
  [[20,19.9],[24,19.9],[24,20.1],[20,20.1]], [[23.9,20],[24.1,20],[24.1,23],[23.9,23]],
  [[20,22.9],[24,22.9],[24,23.1],[20,23.1]], [[19.9,20],[20.1,20],[20.1,23],[19.9,23]],
];
async function session() {
  const bytes = readFileSync(sample);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor };
}
function candidates(store: Awaited<ReturnType<typeof session>>['store'], editor: StoreEditor, plate: RoomPlate) {
  const view = editor.getMutationView();
  const spaces = existingSpaceFootprintEntriesByStorey(store, view).get(42) ?? [];
  return roomCandidatesFromFaces(readFaces(plate), occupancyTest(spaces.map(space => space.footprint), []), spaces);
}

it.skipIf(!available)('native split/merge rewrites real IFC rooms with stable larger identity and exact occupied rereads', async () => {
  const { store, view, editor } = await session();
  const plate = fromRects(flattenRoomRects(rects), .05, Number.MIN_VALUE);
  try {
    const [face] = candidates(store, editor, plate);
    expect(face).toBeDefined();
    expect(face.grossArea).toBeCloseTo(12, 1);
    const [id] = createRoomsInStore(store, editor, 42, [{ outline: face.inner, height: 3, z: 0, Name: 'Native room', grossArea: face.grossArea, netArea: face.netArea, derived: true }]);
    editor.addPropertySet(id, 'Pset_Control', [{ name: 'Evidence', value: 'preserved', type: 'LABEL' }]);
    const guid = editor.getNewEntity(id)!.attributes[0];
    const before = candidates(store, editor, plate);
    expect(before[0].taken).toBe(true);
    expect(before[0].room?.expressId).toBe(id);
    expect(applyLayoutOp(plate, { kind: 'split', a: [21, 20], b: [21, 23] }, .01)).toBe(true);
    const sync = syncRoomLayoutInStore(store, editor, before, readFaces(plate));
    expect(sync.created).toHaveLength(1);
    expect(sync.remesh).toContain(id);
    expect(editor.getNewEntity(id)!.attributes[0]).toBe(guid);
    const splitCandidates = candidates(store, editor, plate);
    expect(splitCandidates).toHaveLength(2);
    expect(splitCandidates.every(room => room.taken)).toBe(true);
    const kept = roomChainInStore(store, editor, id);
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.chain.footprint.some(([x]) => x > 23)).toBe(true);
    expect(applyLayoutOp(plate, { kind: 'remove', at: [21, 21.5] }, .01)).toBe(true);
    const merged = syncRoomLayoutInStore(store, editor, splitCandidates, readFaces(plate));
    expect(merged.deleted).toEqual(sync.created);
    expect(merged.remesh).toEqual([id]);
    expect(editor.getNewEntity(id)!.attributes[0]).toBe(guid);
    const exported = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(parsed.entityIndex.byId.has(id)).toBe(true);
    expect(parsed.entityIndex.byId.has(sync.created[0])).toBe(false);
    expect(new TextDecoder().decode(exported)).toContain('preserved');
    expect(candidates(store, editor, plate)).toHaveLength(1);
    expect(candidates(store, editor, plate)[0].taken).toBe(true);
  } finally { plate.free(); }
});

it.skipIf(!available)('update/no-room refusal preserves graph and creation late refusal preserves allocator', async () => {
  const { store, view, editor } = await session();
  const plate = fromRects(flattenRoomRects(rects), .05, Number.MIN_VALUE);
  try {
    const [face] = candidates(store, editor, plate);
    const params = { outline: face.inner, height: 3, z: 0, Name: 'Room', grossArea: face.grossArea, netArea: face.netArea, derived: true };
    const [id] = createRoomsInStore(store, editor, 42, [params]);
    const snapshot = () => structuredClone({ records: editor.getNewEntities(), journal: view.getMutations() });
    const before = snapshot(), next = view.peekNextExpressId();
    expect(updateRoomOutlineInStore(store, editor, id, 'inner', () => [])).toEqual({ ok: false, reason: 'noRoom' });
    expect(snapshot()).toEqual(before);
    expect(() => createRoomsInStore(store, editor, 42, [params, { ...params, height: -1 }])).toThrow();
    expect(snapshot()).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
    const updated = updateRoomOutlineInStore(store, editor, id, 'center', () => candidates(store, editor, plate));
    expect(updated.ok).toBe(true);
    const chain = roomChainInStore(store, editor, id);
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(chain.chain.footprint.some(([x]) => x < 20.05)).toBe(true);
  } finally { plate.free(); }
});


it.skipIf(!available)('shared source geometry refuses updates without changing either occurrence or allocation', async () => {
  const { store, view, editor } = await session();
  const plate = fromRects(flattenRoomRects(rects), .05, Number.MIN_VALUE);
  try {
    const [face] = candidates(store, editor, plate);
    const params = { outline: face.inner, height: 3, z: 0, Name: 'Shared control', grossArea: face.grossArea, netArea: face.netArea, derived: true };
    const [id, peer] = createRoomsInStore(store, editor, 42, [params, params]);
    editor.setPositionalAttribute(peer, 6, editor.getNewEntity(id)!.attributes[6]);
    // Export/reparse makes the alias a file-supplied shared solid, not merely
    // two authored references the source inverse walk never sees.
    const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const sourceView = new MutablePropertyView(null, 'source'), sourceEditor = new StoreEditor(parsed, sourceView);
    const before = structuredClone({ records: sourceEditor.getNewEntities(), journal: sourceView.getMutations() }), next = sourceView.peekNextExpressId();
    expect(() => updateRoomOutlineInStore(parsed, sourceEditor, id, 'center', () => candidates(parsed, sourceEditor, plate))).toThrow(/shares placement or geometry/);
    expect({ records: sourceEditor.getNewEntities(), journal: sourceView.getMutations() }).toEqual(before);
    expect(sourceView.peekNextExpressId()).toBe(next);
    expect(sourceView.isDeleted(id)).toBe(false);
    expect(sourceView.isDeleted(peer)).toBe(false);
  } finally { plate.free(); }
});

it.skipIf(!available)('native Auto/Pick/footprint policy preserves occupancy, naming and boundary measures', async () => {
  const { store, editor } = await session();
  const plate = fromRects(flattenRoomRects(rects), .05, Number.MIN_VALUE);
  try {
    const rooms = candidates(store, editor, plate);
    const options = { action: 'auto' as const, boundary: 'inner' as const, height: 3, z: 0, existingCount: 0, namePattern: 'Room {n}' };
    const plan = planRoomCreation(rooms, options);
    expect(plan).toHaveLength(1);
    expect(plan[0].Name).toBe('Room 1');
    expect(plan[0].grossArea).toBeGreaterThan(plan[0].netArea);
    const picked = planRoomCreation(rooms, { ...options, action: 'pick', point: [22, 21] });
    expect(picked).toEqual(plan);
    createRoomsInStore(store, editor, 42, plan);
    const occupied = candidates(store, editor, plate);
    expect(planRoomCreation(occupied, options)).toEqual([]);
    expect(() => planRoomCreation(occupied, { ...options, action: 'pick', point: [22, 21] })).toThrow(/already/);
    const footprint = storeyFootprintFaceInStore({ fromWallRects: fromRects }, rects.map(corners => ({ corners, centreline: [corners[0], corners[1]], thickness: .2 })), .05);
    expect(footprint?.centre).toEqual(rooms[0].centre);
  } finally { plate.free(); }
});
