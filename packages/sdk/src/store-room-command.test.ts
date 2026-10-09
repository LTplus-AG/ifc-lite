/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { roomChainInStore } from '../../create/src/in-store/room-store.js';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { StepExporter } from '@ifc-lite/export';
import { RoomLayoutCache, applyLayoutOp, readFaces, occupancyTest, existingSpaceFootprintEntriesByStorey, type RoomWallRect, type RoomPlateFactory } from '@ifc-lite/create';
import { createRoomCommandBackend, RoomCommandConflictError, type RoomGeometryProvider } from './store-room-command.js';

const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
const sample = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
let factory: RoomPlateFactory;
beforeAll(async () => {
  if (!available) { console.warn('Native Room service tests require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
  factory = runtime.SpacePlateHandle;
});
// #6232 D5 area-partition invariant: these storey-local native rectangle
// boundaries enclose one room away from the real Bonsai file's existing room.
const walls: RoomWallRect[] = [
  [[20,19.9],[24,19.9],[24,20.1],[20,20.1]], [[23.9,20],[24.1,20],[24.1,23],[23.9,23]],
  [[20,22.9],[24,22.9],[24,23.1],[20,23.1]], [[19.9,20],[20.1,20],[20.1,23],[19.9,23]],
].map(corners => ({ corners: corners as [number, number][], centreline: [corners[0] as [number, number], corners[1] as [number, number]], thickness: .2 }));
async function setup(provider?: RoomGeometryProvider, millimetres = false) {
  const original = readFileSync(sample);
  const bytes = millimetres ? Buffer.from(original.toString().replace(/\.LENGTHUNIT\.,\$,\.METRE\./g,'.LENGTHUNIT.,.MILLI.,.METRE.')) : original;
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  let model = { modelId: 'm', store, editor, mutationView: view, ownerHistoryId: null };
  const layouts = new RoomLayoutCache();
  const resolve = (modelId: string) => { if (modelId !== 'm') throw new Error('Unknown model'); return model; };
  const backend = createRoomCommandBackend(resolve, provider ?? (async () => ({ walls, factory })), {
    layouts,
    historyHead: () => `${model.mutationView.getMutations().length}:${model.mutationView.getMutations().at(-1)?.id ?? ''}`,
    record: (_id, write) => recordCompoundMutation(model.mutationView, draft => write({ ...model, mutationView: draft, editor: new StoreEditor(model.store, draft) })),
  });
  return { store, view, editor, layouts, backend, async replaceSource() {
    const source = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
    const mutationView = new MutablePropertyView(null, 'm');
    model = { modelId: 'm', store: source, mutationView, editor: new StoreEditor(source, mutationView), ownerHistoryId: null };
  } };
}

it.skipIf(!available)('native SDK Room cut and Undo restore both IFC and the exact retained plate; invalid cuts leave original faces intact', async () => {
  const { view, editor, backend } = await setup();
  try {
    const query = await backend.roomCommand('m', 42, { action: 'query' });
    expect(query.candidates).toHaveLength(1);
    const auto = await backend.roomCommand('m', 42, { action: 'auto' });
    expect(auto.created).toHaveLength(1);
    const guid = editor.getNewEntity(auto.created[0].expressId)!.attributes[0];
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() });
    await expect(backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'split', a: [21, 20], b: [21, 23] } })).resolves.toMatchObject({ created: [{ modelId: 'm' }], updated: [auto.created[0]] });
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
    expect(editor.getNewEntity(auto.created[0].expressId)!.attributes[0]).toBe(guid);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected a recorded Room operation'); });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(1);
    await expect(backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'split', a: [21, 20], b: [99, 99] } })).rejects.toThrow(/outline/);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(1);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    await expect(backend.roomCommand('m', 42, { action: 'auto' })).rejects.toThrow(/unoccupied/);
  } finally { backend.disposeRooms(); }
});

it.skipIf(!available)('#6232 / #6759 history-free positional edits invalidate awaited native preparation without Room writes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { store, view, editor, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const pending = backend.roomCommand('m', 42, { action: 'auto' });
    const history = structuredClone(view.getMutations());
    view.setPositionalAttribute(1231, 0, [{ real: 100 }, { real: 0 }, { real: 0 }], true);
    expect(view.getMutations()).toEqual(history);
    const graph = () => Array.from(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
    const before = structuredClone({ graph: graph(), records: editor.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    release();
    await expect(pending).rejects.toMatchObject({ name: 'RoomCommandConflictError', message: expect.stringMatching(/changed while native/) });
    expect({ graph: graph(), records: editor.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }).toEqual(before);
  } finally { release(); backend.disposeRooms(); }
});

it.skipIf(!available)('awaited native preparation refuses intervening live source edits before allocating any Room graph', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { view, editor, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const pending = backend.roomCommand('m', 42, { action: 'auto' });
    editor.setAttribute(1222, 'Name', 'Concurrent source edit');
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }), next = view.peekNextExpressId();
    release?.();
    // #6232 / #6759: retryable state conflicts retain their typed identity through the existing SDK command.
    await expect(pending).rejects.toMatchObject({ name: 'RoomCommandConflictError', message: expect.stringMatching(/changed while native/) });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
  } finally { release?.(); backend.disposeRooms(); }
});


it.skipIf(!available)('cancelling during native preparation or before a command cannot write after await', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { view, editor, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const controller = new AbortController();
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }), next = view.peekNextExpressId();
    const pending = backend.roomCommand('m', 42, { action: 'auto', signal: controller.signal });
    controller.abort(new Error('Room preparation cancelled'));
    release?.();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
    await expect(backend.roomCommand('m', 42, { action: 'auto', signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
  } finally { release?.(); backend.disposeRooms(); }
});

it.skipIf(!available)('first SDK attachment retains the existing viewer native layout edits (#6232)', async () => {
  const { layouts, backend } = await setup();
  try {
    const held = layouts.read('m', 42, .05, '0:', walls.map(wall => wall.corners), factory);
    const edited = held.plate.duplicate();
    try {
      expect(applyLayoutOp(edited, { kind: 'split', a: [21, 20], b: [21, 23] }, .1)).toBe(true);
      layouts.file('m', 42, .05, '0:', held.walls, edited, readFaces(edited));
    } catch (error) { edited.free(); throw error; }
    // Attaching the SDK to an already edited viewer cache must retain both
    // native faces even though no SDK command has seen this source store yet.
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
  } finally { backend.disposeRooms(); }
});

it.skipIf(!available)('replacing a parsed source under the same model id discards the old native edited layout (#6232)', async () => {
  const { backend, replaceSource } = await setup();
  try {
    await backend.roomCommand('m', 42, { action: 'auto' });
    await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } });
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
    await replaceSource();
    const current = await backend.roomCommand('m', 42, { action: 'query' });
    expect(current.candidates).toHaveLength(1);
    expect(current.candidates[0].taken).toBe(false);
  } finally { backend.disposeRooms(); }
});


it.skipIf(!available)('native SDK footprint and boundary update preserve IFC identity, metadata and exact Undo (#6232)', async () => {
  const { store, view, editor, backend } = await setup();
  try {
    await expect(backend.roomCommand('m', 42, { action: 'footprint' })).rejects.toThrow(/overlap/);
    // Clear the real Bonsai source room first: Footprint covers the whole
    // storey and must refuse even rooms outside this detector's rectangles.
    for (const room of existingSpaceFootprintEntriesByStorey(store, view).get(42) ?? []) editor.removeEntity(room.expressId);
    const footprint = await backend.roomCommand('m', 42, { action: 'footprint', boundary: 'inner', namePattern: 'Footprint {n}', ObjectType: 'Control' });
    expect(footprint.created).toHaveLength(1);
    const id = footprint.created[0].expressId, attrs = editor.getNewEntity(id)!.attributes;
    const guid = attrs[0];
    expect(attrs[2]).toMatch(/^Footprint /);
    expect(attrs[4]).toBe('Control');
    editor.addPropertySet(id, 'Pset_Control', [{ name: 'Evidence', value: 'retained', type: 'LABEL' }]);
    const inner = roomChainInStore(store, editor, id);
    expect(inner.ok).toBe(true);
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() });
    expect(await backend.roomCommand('m', 42, { action: 'update', expressIds: [id, 1222], boundary: 'center' })).toMatchObject({ updated: [footprint.created[0]], skipped: [{ modelId: 'm', expressId: 1222 }] });
    const centered = roomChainInStore(store, editor, id);
    expect(centered.ok).toBe(true);
    if (inner.ok && centered.ok) {
      expect(centered.chain.footprint).not.toEqual(inner.chain.footprint);
      expect(Math.min(...centered.chain.footprint.map(p => p[0]))).toBeCloseTo(20, 2);
    }
    expect(editor.getNewEntity(id)!.attributes[0]).toBe(guid);
    const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const exported = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(existingSpaceFootprintEntriesByStorey(exported).get(42)?.find(space => space.expressId === id)?.footprint).toHaveLength(4);
    expect(new TextDecoder().decode(bytes)).toContain('retained');
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected recorded Room update'); });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    const next = view.peekNextExpressId();
    await expect(backend.roomCommand('m', 42, { action: 'footprint', minArea: 999 })).rejects.toThrow(/overlap/);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    await expect(backend.roomCommand('m', 42, { action: 'update', expressIds: [1222] })).rejects.toThrow(/No selected room/);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
  } finally { backend.disposeRooms(); }
});

it.skipIf(!available)('native SDK drag/remove synchronize exported spaces and prune no-op refuses atomically (#6232)', async () => {
  const { store, view, editor, backend } = await setup();
  try {
    const [root] = (await backend.roomCommand('m', 42, { action: 'auto' })).created;
    editor.addPropertySet(root.expressId, 'Pset_Control', [{ name: 'Evidence', value: 'dragged room', type: 'LABEL' }]);
    const guid = editor.getNewEntity(root.expressId)!.attributes[0];
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() });
    expect(await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'drag', from: [24,23], to: [25,23] } })).toMatchObject({ updated: [root], created: [], deleted: [] });
    const dragged = await backend.roomCommand('m', 42, { action: 'query' });
    expect(dragged.candidates[0].grossArea).toBeCloseTo(13.5, 1);
    const chain = roomChainInStore(store, editor, root.expressId);
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(Math.max(...chain.chain.footprint.map(p => p[0]))).toBeGreaterThan(24.5);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected recorded Room drag'); });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates[0].grossArea).toBeCloseTo(12, 1);
    const split = await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } });
    expect(split.created).toHaveLength(1);
    const splitGraph = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() });
    expect(await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'remove', at: [21,21.5] } })).toMatchObject({ updated: [root], deleted: split.created, created: [] });
    expect(editor.getNewEntity(root.expressId)!.attributes[0]).toBe(guid);
    const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const exported = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(exported.entityIndex.byId.has(root.expressId)).toBe(true);
    expect(exported.entityIndex.byId.has(split.created[0].expressId)).toBe(false);
    expect(new TextDecoder().decode(bytes)).toContain('dragged room');
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected recorded Room remove'); });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(splitGraph);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
    const next = view.peekNextExpressId();
    await expect(backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'prune' } })).rejects.toThrow(/changed nothing/);
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(splitGraph);
    expect(view.peekNextExpressId()).toBe(next);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
  } finally { backend.disposeRooms(); }
});


it.skipIf(!available)('native SDK prune removes a real dangling wall notch and Undo restores the exact face (#6232)', async () => {
  const spur: RoomWallRect = { corners: [[21.9,20],[22.1,20],[22.1,21.5],[21.9,21.5]], centreline: [[22,20],[22,21.5]], thickness: .2 };
  const { store, view, editor, backend } = await setup(async () => ({ walls: [...walls, spur], factory }));
  try {
    const [root] = (await backend.roomCommand('m', 42, { action: 'auto' })).created;
    const beforeChain = roomChainInStore(store, editor, root.expressId);
    expect(beforeChain.ok).toBe(true);
    if (beforeChain.ok) expect(beforeChain.chain.footprint.length).toBeGreaterThan(4);
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() });
    expect(await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'prune' } })).toMatchObject({ updated: [root], created: [], deleted: [] });
    const clean = roomChainInStore(store, editor, root.expressId);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.chain.footprint).toHaveLength(4);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected recorded prune'); });
    expect({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }).toEqual(before);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates[0].inner.length).toBeGreaterThan(4);
  } finally { backend.disposeRooms(); }
});


it.skipIf(!available)('native triangle occupancy refuses Footprint even above the creation area cutoff (#6232)', async () => {
  const occupied = occupancyTest([], [[[21,20.5],[23,20.5],[22,22.5]]]);
  const { view, editor, backend } = await setup(async () => ({ walls, factory, spaces: [], occupied }));
  try {
    const before = structuredClone({ records: editor.getNewEntities(), journal: view.getMutations() }), next = view.peekNextExpressId();
    await expect(backend.roomCommand('m', 42, { action: 'footprint', minArea: 999 })).rejects.toThrow(/overlap/);
    expect({ records: editor.getNewEntities(), journal: view.getMutations() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
  } finally { backend.disposeRooms(); }
});

it.skipIf(!available)('layout-only native split has an ordinary Undo step without IFC graph edits (#6758)', async () => {
  const { view, editor, backend } = await setup();
  try {
    const before = await backend.roomCommand('m', 42, { action: 'query' });
    const next = view.peekNextExpressId();
    expect(await backend.roomCommand('m', 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } })).toMatchObject({ created: [], updated: [], deleted: [] });
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toHaveLength(2);
    expect(view.getMutations()).toHaveLength(1);
    expect(view.getMutations()[0].type).toBe('SESSION_EDIT');
    expect(view.getEffectiveChanges()).toEqual([]);
    expect(editor.getNewEntities()).toEqual([]);
    expect(view.peekNextExpressId()).toBe(next);
    expect(undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound session history'); })).toBe(1);
    expect((await backend.roomCommand('m', 42, { action: 'query' })).candidates).toEqual(before.candidates);
    expect(view.getMutations()).toEqual([]);
    expect(view.getEffectiveChanges()).toEqual([]);
  } finally { backend.disposeRooms(); }
});

for (const edit of ['atomic publish', 'compound Undo', 'history-free removal/reapply'] as const) it.skipIf(!available)(`#6232 / #6759 ${edit} invalidates pending native Room preparation even with restored history`, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { store, view, editor, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const shift = (draft: MutablePropertyView) => draft.setPositionalAttribute(1231, 0, [{ real: 100 }, { real: 0 }, { real: 0 }], true);
    if (edit === 'compound Undo') recordCompoundMutation(view, draft => draft.setPositionalAttribute(1231, 0, [{ real: 50 }, { real: 0 }, { real: 0 }]));
    const pending = backend.roomCommand('m', 42, { action: 'auto' });
    if (edit === 'atomic publish') view.runAtomic(shift);
    else if (edit === 'compound Undo') undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound undo'); });
    else { shift(view); view.removePositionalMutation(1231, 0); shift(view); }
    const graph = () => Array.from(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
    const before = structuredClone({ graph: graph(), records: editor.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    release();
    await expect(pending).rejects.toMatchObject({ name: 'RoomCommandConflictError' });
    expect({ graph: graph(), records: editor.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }).toEqual(before);
  } finally { release(); backend.disposeRooms(); }
});

it.skipIf(!available)('#6232 / #6759 rejected detached draft preserves live token and pending native Room preparation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { store, view, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const graph = () => Array.from(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
    const before = structuredClone({ graph: graph(), records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    const pending = backend.roomCommand('m', 42, { action: 'auto' });
    expect(() => view.runAtomic(draft => { draft.setPositionalAttribute(1231, 0, [{ real: 100 }, { real: 0 }, { real: 0 }], true); throw new Error('Refused detached edit'); })).toThrow('Refused detached edit');
    expect({ graph: graph(), records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }).toEqual(before);
    release();
    expect((await pending).created).toHaveLength(1);
  } finally { release(); backend.disposeRooms(); }
});

function secondStorey(editor: StoreEditor, fileUnitsPerMetre = 1): number {
  const p = editor.addEntity('IfcCartesianPoint', [[0,0,3*fileUnitsPerMetre]]).expressId;
  const a = editor.addEntity('IfcAxis2Placement3D', [`#${p}`,null,null]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [null,`#${a}`]).expressId;
  const id = editor.addEntity('IfcBuildingStorey', ['0Storey000000000000005',null,'Upper',null,null,`#${placement}`,null,null,'.ELEMENT.',3*fileUnitsPerMetre]).expressId;
  editor.setPositionalAttribute(60,5,['#42',`#${id}`]);
  return id;
}

it.skipIf(!available)('#7324 AutoAll prepares all native storeys without writes and commits real spaces in one recorded Undo operation', async () => {
  const {store,view,editor,backend} = await setup();
  const upper = secondStorey(editor);
  const before = structuredClone({ records:editor.getNewEntities(),journal:view.getMutations() });
  try {
    const preparing = backend.prepareRoomCommand('m',42,{action:'autoAll'});
    await expect(preparing).resolves.toBeDefined();
    const prepared = await preparing;
    expect({records:editor.getNewEntities(),journal:view.getMutations()}).toEqual(before);
    expect(prepared.result.storeys?.map(row=>[row.storeyId,row.status,row.created.length])).toEqual([[42,'ready',1],[upper,'ready',1]]);
    const committed = prepared.commit();
    expect(committed.created).toHaveLength(2);
    const bytes = new StepExporter(store,view).export({schema:'IFC4',applyMutations:true}).content;
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
    for (const ref of committed.created) expect(parsed.entities.getTypeName(ref.expressId)).toBe('IfcSpace');
    undoRecordedMutationOperations(view,1,()=>{throw new Error('A recorded AutoAll group was required');});
    expect({records:editor.getNewEntities(),journal:view.getMutations()}).toEqual(before);
    prepared.dispose();
  } finally {backend.disposeRooms();}
});

it.skipIf(!available)('#7324 AutoAll discloses unavailable storeys and refuses partial writes; noWalls is an honest empty result', async () => {
  const {view,editor,backend} = await setup(async (_model,id)=>({walls:id===42?walls:[],factory,...(id!==42?{unavailable:'Untrusted native storey frame'}:{})}));
  secondStorey(editor);
  const before = structuredClone({records:editor.getNewEntities(),journal:view.getMutations()});
  try {
    const preparing = backend.prepareRoomCommand('m',42,{action:'autoAll'});
    await expect(preparing).resolves.toBeDefined();
    const prepared = await preparing;
    expect(prepared.result.storeys?.map(row=>row.status)).toEqual(['ready','unavailable']);
    expect(prepared.result.created).toHaveLength(0);
    expect(()=>prepared.commit()).toThrow(/unavailable/);
    expect({records:editor.getNewEntities(),journal:view.getMutations()}).toEqual(before);
    prepared.dispose();
  } finally {backend.disposeRooms();}
  const empty = await setup(async()=>({walls:[],factory}));
  try {
    const beforeEmpty = structuredClone(empty.view.getMutations());
    const prepared = await empty.backend.prepareRoomCommand('m',42,{action:'autoAll'});
    expect(prepared.result.storeys?.[0].status).toBe('noWalls');
    expect(prepared.commit().created).toHaveLength(0);
    expect(empty.view.getMutations()).toEqual(beforeEmpty);
    prepared.dispose();
  } finally {empty.backend.disposeRooms();}
});

it.skipIf(!available)('#7324 AutoAll detects direct native edits across storey awaits and abort/held geometry leases without writes', async () => {
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const f=await setup(async(_model,id)=>{if(id!==42)await gate;return{walls,factory};});
  secondStorey(f.editor);
  try {
    const pending=f.backend.prepareRoomCommand('m',42,{action:'autoAll'});
    await Promise.resolve(); await Promise.resolve();
    f.view.setPositionalAttribute(42,2,'Changed during native geometry',true);
    const current=structuredClone(f.view.getMutations());
    release(); await expect(pending).rejects.toThrow(/changed/);
    expect(f.view.getMutations()).toEqual(current);
  } finally {release();f.backend.disposeRooms();}
  let geometryCurrent=true;
  const h=await setup(async()=>({walls,factory,validate:()=>{if(!geometryCurrent)throw new Error('Native mesh ownership changed');}}));
  try {
    const prepared=await h.backend.prepareRoomCommand('m',42,{action:'autoAll'});
    geometryCurrent=false;expect(()=>prepared.commit()).toThrow(/mesh ownership/);prepared.dispose();
    geometryCurrent=true;
    const controller=new AbortController();
    const cancelled=await h.backend.prepareRoomCommand('m',42,{action:'autoAll',signal:controller.signal});
    controller.abort();expect(()=>cancelled.commit()).toThrow();cancelled.dispose();
    expect(h.view.getNewEntities().some(e=>e.type.toUpperCase()==='IFCSPACE')).toBe(false);
  } finally {h.backend.disposeRooms();}
});

for (const mm of [false,true]) it.skipIf(!available)(`#7324 native AutoAll independent export retains SI dimensions on ${mm?'millimetre':'metre'} source units`, async () => {
  const f=await setup(undefined,mm);
  try {
    secondStorey(f.editor,mm?1000:1);
    const prepared=await f.backend.prepareRoomCommand('m',42,{action:'autoAll',height:3});
    const result=prepared.commit();prepared.dispose();
    const bytes=new StepExporter(f.store,f.view).export({schema:'IFC4',applyMutations:true}).content;
    const parsed=await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
    const reader=new StoreEditor(parsed,new MutablePropertyView(null,'m'));
    for (const ref of result.created) {
      const shape=roomChainInStore(parsed,reader,ref.expressId);
      expect(shape).toMatchObject({ok:true});
      if (shape.ok) {expect(shape.chain.thickness).toBeCloseTo(3);expect(Math.max(...shape.chain.footprint.map(p=>p[0]))).toBeCloseTo(23.9);}
    }
  } finally {f.backend.disposeRooms();}
});

it.skipIf(!available)('#7324 AutoAll distinguishes actual occupied native faces and rejects changed held storey population', async () => {
  const f=await setup();
  try {
    const first=await f.backend.prepareRoomCommand('m',42,{action:'autoAll'});first.commit();first.dispose();
    const journal=structuredClone(f.view.getMutations());
    const occupied=await f.backend.prepareRoomCommand('m',42,{action:'autoAll'});
    expect(occupied.result.storeys?.[0].status).toBe('occupied');
    expect(occupied.commit().created).toHaveLength(0);occupied.dispose();expect(f.view.getMutations()).toEqual(journal);
    const held=await f.backend.prepareRoomCommand('m',42,{action:'autoAll'});
    secondStorey(f.editor);expect(()=>held.commit()).toThrow(/changed/);held.dispose();
  } finally {f.backend.disposeRooms();}
});


it.skipIf(!available)('#7324 AutoAll refuses missing, wrong-type and deleted native anchors before geometry or writes', async () => {
  let calls = 0;
  const f = await setup(async () => { calls++; return { walls, factory }; });
  try {
    const graph = () => Array.from(new StepExporter(f.store, f.view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-09T00:00:00' }).content);
    for (const anchor of [999999, 1222, 42]) {
      if (anchor === 42) f.editor.removeEntity(anchor);
      const before = structuredClone({ graph: graph(), journal: f.view.getMutations(), next: f.view.peekNextExpressId() });
      await expect(f.backend.prepareRoomCommand('m', anchor, { action: 'autoAll' })).rejects.toThrow(/anchor.*storey/i);
      expect(calls).toBe(0);
      expect({ graph: graph(), journal: f.view.getMutations(), next: f.view.peekNextExpressId() }).toEqual(before);
    }
  } finally { f.backend.disposeRooms(); }
});

it.skipIf(!available)('#7324 AutoAll disposed, applied and changed-layout approvals expose native conflict errors', async () => {
  const f = await setup();
  try {
    const disposed = await f.backend.prepareRoomCommand('m', 42, { action: 'autoAll' });
    disposed.dispose(); expect(() => disposed.commit()).toThrow(RoomCommandConflictError);
    const changed = await f.backend.prepareRoomCommand('m', 42, { action: 'autoAll' });
    f.layouts.clearModel('m'); expect(() => changed.commit()).toThrow(RoomCommandConflictError); changed.dispose();
    const applied = await f.backend.prepareRoomCommand('m', 42, { action: 'autoAll' });
    applied.commit(); const journal = structuredClone(f.view.getMutations());
    expect(() => applied.commit()).toThrow(RoomCommandConflictError);
    expect(f.view.getMutations()).toEqual(journal); applied.dispose();
  } finally { f.backend.disposeRooms(); }
});


it.skipIf(!available)('#7324 AutoAll counts unsupported live spaces independently of readable footprints', async () => {
  const f = await setup(async (_model, id) => ({ walls: id === 42 ? walls : [], factory }));
  try {
    const upper = secondStorey(f.editor);
    const space = f.editor.addEntity('IfcSpace', [generateIfcGuid(), null, 'Unsupported native room', null, null, null, null, null, '.ELEMENT.', '.NOTDEFINED.', null]).expressId;
    f.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${upper}`, [`#${space}`]]);
    const prepared = await f.backend.prepareRoomCommand('m', 42, { action: 'autoAll' });
    expect(prepared.result.storeys?.find(row => row.storeyId === upper)).toMatchObject({ status: 'noWalls', roomCount: 1 });
    prepared.dispose();
  } finally { f.backend.disposeRooms(); }
});
