/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import type { EntityRef, RoomCommandResult } from '@ifc-lite/sdk';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { existingSpaceFootprintEntriesByStorey } from '@ifc-lite/create';
import type { LoadedModel } from '../context.js';
import type { CallToolResult } from '../protocol/index.js';
import { liveToolSession } from '../test/live-tool-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Public native Room tests require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
const exported = (model: LoadedModel | null) => model ? new TextDecoder().decode(new StepExporter(model.store, model.backend.getMutationView() ?? undefined).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content) : undefined;
const outcome = (result: CallToolResult): RoomCommandResult => {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toHaveProperty('created');
  return result.structuredContent as unknown as RoomCommandResult;
};

// #6232 D5: real Bonsai file + canonical authored walls, native tessellation
// and DCEL through the actual public JSON-RPC route. No supplied rectangles.
for (const count of [1, 2]) it.skipIf(!available)(`public Room query/Auto/edit/Undo retain IFC metadata and peer isolation (${count} models)`, async () => {
  const { registry, call } = await liveToolSession(count);
  const target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
  const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = exported(peer);
  try {
    // Publicly remove existing source spaces to qualify empty-storey Footprint.
    for (const source of iterateEffectiveEntityIds(model.store, null, ['IFCSPACE'])) {
      expect((await call('entity_delete', { model_id: target, express_id: source.expressId })).isError).not.toBe(true);
    }
    const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
    points.forEach((Start, i) => model.bim.store.addWall(target, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 }));
    const before = exported(model);
    const room = (command: Record<string, unknown>) => call('room_command', { model_id: target, storey_express_id: 42, command });
    const query = outcome(await room({ action: 'query' }));
    const candidate = query.candidates.find(face => face.centre.some(([x]) => x > 20));
    expect(candidate).toBeDefined();
    expect(candidate?.taken).toBe(false);
    const auto = outcome(await room({ action: 'auto', namePattern: 'Public native {n}' }));
    const added = auto.created.find(ref => model.backend.getMutationView()!.getNewEntity(ref.expressId)?.attributes[2]?.toString().startsWith('Public native'));
    expect(added).toBeDefined();
    const ref = added as EntityRef;
    const view = model.backend.getMutationView()!, guid = view.getNewEntity(ref.expressId)!.attributes[0];
    const occupiedGraph = structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    expect((await room({ action: 'footprint' })).isError).toBe(true);
    expect({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }).toEqual(occupiedGraph);
    expect(exported(peer)).toEqual(peerBefore);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(exported(model)).toEqual(before);
    const footprint = outcome(await room({ action: 'footprint', namePattern: 'Public footprint {n}' }));
    expect(footprint.created).toHaveLength(1);
    const footprintShape = existingSpaceFootprintEntriesByStorey(model.store, model.backend.getMutationView()!).get(42)!.find(space => space.expressId === footprint.created[0].expressId)!;
    expect(footprintShape.footprint.length).toBeGreaterThanOrEqual(4);
    // Inner boundary subtracts half the authored 0.2 m wall thickness.
    expect(Math.min(...footprintShape.footprint.map(([x]) => x))).toBeCloseTo(20.1);
    expect(Math.max(...footprintShape.footprint.map(([x]) => x))).toBeCloseTo(23.9);
    expect(Math.min(...footprintShape.footprint.map(([, y]) => y))).toBeCloseTo(20.1);
    expect(Math.max(...footprintShape.footprint.map(([, y]) => y))).toBeCloseTo(22.9);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(exported(model)).toEqual(before);
    const picked = outcome(await room({ action: 'pick', point: [22,21], namePattern: 'Picked native {n}' }));
    expect(picked.created).toHaveLength(1);
    const pickedRef = picked.created[0];
    const pickedGuid = view.getNewEntity(pickedRef.expressId)!.attributes[0];
    expect(pickedGuid).not.toBe(guid);
    model.bim.mutate.setProperty(pickedRef, 'Pset_RoomEvidence', 'Evidence', 'real-model-preserved');
    const snapshot = () => structuredClone({ records: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), journal: view.getMutations(), properties: view.getForEntity(pickedRef.expressId), quantities: view.getQuantitiesForEntity(pickedRef.expressId) });
    const beforeUpdate = snapshot();
    const outline = () => existingSpaceFootprintEntriesByStorey(model.store, view).get(42)!.find(space => space.expressId === pickedRef.expressId)!.footprint;
    const originalOutline = structuredClone(outline());
    const updated = outcome(await room({ action: 'update', expressIds: [pickedRef.expressId], boundary: 'outer' }));
    expect(updated.updated).toEqual([pickedRef]);
    expect(outline()).not.toEqual(originalOutline);
    expect(view.getNewEntity(pickedRef.expressId)!.attributes[0]).toBe(pickedGuid);
    expect(exported(model)).toContain('real-model-preserved');
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(snapshot()).toEqual(beforeUpdate);
    const dragged = outcome(await room({ action: 'edit', operation: { kind: 'drag', from: [20,20], to: [19.5,20] } }));
    expect(dragged.updated).toContainEqual(pickedRef);
    expect(outline()).not.toEqual(originalOutline);
    expect(view.getNewEntity(pickedRef.expressId)!.attributes[0]).toBe(pickedGuid);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(snapshot()).toEqual(beforeUpdate);
    expect((await room({ action: 'edit', operation: { kind: 'prune' } })).isError).toBe(true);
    expect(snapshot()).toEqual(beforeUpdate);
    const beforeCut = snapshot();
    const edit = outcome(await room({ action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } }));
    expect(edit.created).toHaveLength(1);
    expect(edit.updated).toContainEqual(pickedRef);
    expect(view.getNewEntity(pickedRef.expressId)!.attributes[0]).toBe(pickedGuid);
    expect(exported(model)).toContain('real-model-preserved');
    expect(exported(peer)).toEqual(peerBefore);
    const cutQuery = outcome(await room({ action: 'query' }));
    expect(cutQuery.candidates.filter(face => face.centre.some(([x]) => x > 20))).toHaveLength(2);
    const splitState = snapshot();
    const removed = outcome(await room({ action: 'edit', operation: { kind: 'remove', at: [21,21.5] } }));
    expect(removed.deleted).toHaveLength(1);
    expect(outcome(await room({ action: 'query' })).candidates.filter(face => face.centre.some(([x]) => x > 20))).toHaveLength(1);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(snapshot()).toEqual(splitState);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(snapshot()).toEqual(beforeCut);
    const undoQuery = outcome(await room({ action: 'query' }));
    expect(undoQuery.candidates.filter(face => face.centre.some(([x]) => x > 20))).toHaveLength(1);
    expect((await room({ action: 'edit', operation: { kind: 'split', a: [21,20], b: [99,99] } })).isError).toBe(true);
    expect(snapshot()).toEqual(beforeCut);
    expect(view.getNewEntity(pickedRef.expressId)!.attributes[0]).toBe(pickedGuid);
    expect(exported(peer)).toEqual(peerBefore);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
}, 60000);

it.skipIf(!available)('public Room command refuses ambiguous routing and read-only writes before geometry/overlay changes', async () => {
  const multi = await liveToolSession(2), readonly = await liveToolSession(1, true);
  try {
    const before = multi.registry.get('beta')!.bim.export.ifc();
    expect((await multi.call('room_command', { storey_express_id: 42, command: { action: 'auto' } })).isError).toBe(true);
    expect(multi.registry.get('beta')!.bim.export.ifc()).toEqual(before);
    const readonlyBefore = readonly.registry.get('alpha')!.bim.export.ifc();
    expect((await readonly.call('room_command', { storey_express_id: 42, command: { action: 'auto' } })).isError).toBe(true);
    expect(readonly.registry.get('alpha')!.bim.export.ifc()).toEqual(readonlyBefore);
  } finally {
    for (const loaded of multi.registry.list()) loaded.backend.dispose();
    for (const loaded of readonly.registry.list()) loaded.backend.dispose();
  }
});

for (const count of [1, 2]) it.skipIf(!available)(`public Prune removes a native wall notch and Undo restores the face (${count} models, #6232)`, async () => {
  const { registry, call } = await liveToolSession(count);
  const target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
  const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = exported(peer);
  try {
    const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
    points.forEach((Start, i) => model.bim.store.addWall(target, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 }));
    model.bim.store.addWall(target, 42, { Start: [22,20,0], End: [22,21.5,0], Thickness: .2, Height: 3 });
    const room = (command: Record<string, unknown>) => call('room_command', { model_id: target, storey_express_id: 42, command });
    const picked = outcome(await room({ action: 'pick', point: [23,22] }));
    expect(picked.created).toHaveLength(1);
    const ref = picked.created[0], view = model.backend.getMutationView()!;
    const shape = () => existingSpaceFootprintEntriesByStorey(model.store, view).get(42)!.find(space => space.expressId === ref.expressId)!.footprint;
    expect(shape().length).toBeGreaterThan(4);
    const snapshot = () => structuredClone({ records: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), journal: view.getMutations(), quantities: view.getQuantitiesForEntity(ref.expressId) });
    const before = snapshot(), guid = view.getNewEntity(ref.expressId)!.attributes[0];
    const pruned = outcome(await room({ action: 'edit', operation: { kind: 'prune' } }));
    expect(pruned.updated).toContainEqual(ref);
    expect(pruned.created).toEqual([]);
    expect(pruned.deleted).toEqual([]);
    expect(shape()).toHaveLength(4);
    expect(view.getNewEntity(ref.expressId)!.attributes[0]).toBe(guid);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(snapshot()).toEqual(before);
    expect(shape().length).toBeGreaterThan(4);
    expect(outcome(await room({ action: 'query' })).candidates.find(face => face.centre.some(([x]) => x > 20))!.inner.length).toBeGreaterThan(4);
    expect(exported(peer)).toEqual(peerBefore);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
}, 60000);

for (const count of [1, 2]) it.skipIf(!available)(`#6232 layout-only public Room edit has its own Undo without changing IFC (${count} models)`, async () => {
  const { registry, call } = await liveToolSession(count);
  const target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
  const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = exported(peer);
  try {
    const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
    for (const [i, Start] of points.entries()) model.bim.store.addWall(target, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
    const room = (command: Record<string, unknown>) => call('room_command', { model_id: target, storey_express_id: 42, command });
    const farFaces = async () => outcome(await room({ action: 'query' })).candidates.filter(face => face.centre.some(([x]) => x > 20));
    const original = await farFaces();
    expect(original).toHaveLength(1);
    expect(original[0].taken).toBe(false);
    const view = model.backend.getMutationView()!, before = exported(model), next = view.peekNextExpressId();
    const records = structuredClone(view.getNewEntities());
    const split = outcome(await room({ action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } }));
    expect(split.created).toEqual([]);
    expect(split.updated).toEqual([]);
    expect(split.deleted).toEqual([]);
    expect(await farFaces()).toHaveLength(2);
    expect(exported(model)).toBe(before);
    expect(view.getNewEntities()).toEqual(records);
    expect(view.peekNextExpressId()).toBe(next);
    expect(exported(peer)).toBe(peerBefore);
    expect((await call('mutation_undo', { model_id: target, n: 1 })).isError).not.toBe(true);
    expect(exported(model)).toBe(before);
    expect(await farFaces()).toEqual(original);
    expect(view.getNewEntities()).toEqual(records);
    expect(view.peekNextExpressId()).toBe(next);
    expect(exported(peer)).toBe(peerBefore);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});
