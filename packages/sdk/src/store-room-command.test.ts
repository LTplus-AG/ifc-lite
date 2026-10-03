/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { roomChainInStore } from '../../create/src/in-store/room-store.js';
import { StepExporter } from '@ifc-lite/export';
import { RoomLayoutCache, applyLayoutOp, readFaces, occupancyTest, existingSpaceFootprintEntriesByStorey, type RoomWallRect, type RoomPlateFactory } from '@ifc-lite/create';
import { createRoomCommandBackend, type RoomGeometryProvider } from './store-room-command.js';

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
async function setup(provider?: RoomGeometryProvider) {
  const bytes = readFileSync(sample);
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

it.skipIf(!available)('awaited native preparation refuses intervening live source edits before allocating any Room graph', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { view, editor, backend } = await setup(async () => { await gate; return { walls, factory }; });
  try {
    const pending = backend.roomCommand('m', 42, { action: 'auto' });
    editor.setAttribute(1222, 'Name', 'Concurrent source edit');
    const before = structuredClone({ records: editor.getNewEntities().sort((a, b) => a.expressId - b.expressId), journal: view.getMutations() }), next = view.peekNextExpressId();
    release?.();
    await expect(pending).rejects.toThrow(/changed while native/);
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
