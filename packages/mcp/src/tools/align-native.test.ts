/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIfcModel } from '../loader.js';
import { beforeAll, expect, it } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { roomFramePlanOffsets, roomFrameToModelWorld, storeyPlanFrame, toStoreyLocal, type AlignMode } from '@ifc-lite/create';
import type { LoadedModel } from '../context.js';
import { createAlignCommandBackend } from '@ifc-lite/sdk';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';
import { provideHeadlessAlignGeometry } from '../headless-backend-align.js';
import { AnchorEntityReader } from '../../../create/src/in-store/resolve-anchor.js';
import { liveToolSession } from '../test/live-tool-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Native Align tests require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
const exportModel = (model: LoadedModel) => new StepExporter(model.store, model.backend.getMutationView() ?? undefined).export({ schema: model.store.schemaVersion ?? 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content;
async function graph(model: LoadedModel) {
  const store = await new IfcParser().parseColumnar(exportModel(model).slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => ({ id, ...extractor.extractEntity(location)! })).sort((a, b) => a.id - b.id);
}
/** Independent oracle: measure each actual native vertex, without Align's box/edge planner. */
async function extents(model: LoadedModel, ids: readonly number[]) {
  const bytes = exportModel(model);
  const source = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const frame = storeyPlanFrame(source, 42)!;
  const processor = new GeometryProcessor({ enableInstancing: false });
  try {
    await processor.init();
    const { meshes, coordinateInfo: coord } = await processor.process(bytes);
    const { cx, cy } = roomFramePlanOffsets(coord), { dx, dy } = roomFrameToModelWorld(coord);
    return new Map(ids.map(id => {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      let vertices = 0;
      for (const mesh of meshes.filter(mesh => mesh.expressId === id)) {
        const origin = mesh.origin ?? [0, 0, 0];
        for (let i = 0; i < mesh.positions.length; i += 3) {
          const local = toStoreyLocal(frame, [mesh.positions[i] + origin[0] + cx + dx, -mesh.positions[i + 2] - origin[2] + cy + dy]);
          for (let axis = 0; axis < 2; axis++) { lo[axis] = Math.min(lo[axis], local[axis]); hi[axis] = Math.max(hi[axis], local[axis]); }
          vertices++;
        }
      }
      expect(vertices).toBeGreaterThan(0);
      return [id, { lo, hi }] as const;
    }));
  } finally { processor.dispose(); }
}

for (const count of [1, 2]) it.skipIf(!available)(`#6232 public Align measures real Bonsai meshes, distinct shifts, all six modes and one Undo (${count} models)`, async () => {
  const { registry, call } = await liveToolSession(count), target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
  const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = peer && await graph(peer);
  try {
    const a = model.bim.store.addColumn(target, 42, { Position: [20, 20, 0], Width: .4, Depth: .6, Height: 3 }).expressId;
    const b = model.bim.store.addColumn(target, 42, { Position: [30, 25, 0], Width: .8, Depth: .3, Height: 3 }).expressId;
    const before = await graph(model), ids = [1222, a, b], original = await extents(model, ids);
    for (const mode of ['left', 'centre', 'right', 'top', 'middle', 'bottom'] satisfies AlignMode[]) {
      const result = await call('edit_element_geometry', { model_id: target, operation: { kind: 'align', reference_id: 1222, express_ids: [a, b], mode } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const after = await extents(model, ids), axis = ['left', 'centre', 'right'].includes(mode) ? 0 : 1;
      const coordinate = (box: {lo: number[]; hi: number[]}) => mode === 'left' || mode === 'bottom' ? box.lo[axis] : mode === 'right' || mode === 'top' ? box.hi[axis] : (box.lo[axis] + box.hi[axis]) / 2;
      expect(after.get(1222)).toEqual(original.get(1222));
      for (const id of [a, b]) {
        expect(coordinate(after.get(id)!)).toBeCloseTo(coordinate(after.get(1222)!), 4);
        const other = 1 - axis;
        expect(after.get(id)!.lo[other]).toBeCloseTo(original.get(id)!.lo[other], 4);
        expect(after.get(id)!.hi[other]).toBeCloseTo(original.get(id)!.hi[other], 4);
      }
      expect(coordinate(after.get(a)!) - coordinate(original.get(a)!)).not.toBeCloseTo(coordinate(after.get(b)!) - coordinate(original.get(b)!));
      if (peer) expect(await graph(peer)).toEqual(peerBefore);
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model)).toEqual(before);
    }
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});

it.skipIf(!available)('#6232 distinct Align root shifts carry a joined neighbour and Undo restores the whole native graph', async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  try {
    const a = model.bim.store.addWall('alpha', 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 }).expressId;
    const b = model.bim.store.addWall('alpha', 42, { Start: [24,20,0], End: [24,24,0], Thickness: .2, Height: 3 }).expressId;
    model.bim.store.joinWalls('alpha', a, b);
    const column = model.bim.store.addColumn('alpha', 42, { Position: [35,30,0], Width: .4, Depth: .4, Height: 3 }).expressId;
    const before = await graph(model), original = await extents(model, [1222, a, b, column]);
    const result = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [a, column], mode: 'left' } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const after = await extents(model, [1222,a,b,column]);
    expect(after.get(a)!.lo[0]).toBeCloseTo(after.get(1222)!.lo[0], 4);
    expect(after.get(column)!.lo[0]).toBeCloseTo(after.get(1222)!.lo[0], 4);
    expect(after.get(b)!.lo[0]).not.toBeCloseTo(original.get(b)!.lo[0]);
    const alreadyAligned = await graph(model);
    const conflicting = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [a,b], mode: 'left' } });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.structuredContent?.message).toContain('incompatible translations');
    expect(await graph(model)).toEqual(alreadyAligned);
    expect((await call('mutation_undo', {})).isError).not.toBe(true);
    expect(await graph(model)).toEqual(before);
    expect(await extents(model, [a,b,column])).toEqual(new Map([a,b,column].map(id => [id,original.get(id)!])));
    const refusalBefore = await graph(model);
    const refusal = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: b, express_ids: [column,a], mode: 'left' } });
    expect(refusal.isError).toBe(true);
    expect(await graph(model)).toEqual(refusalBefore);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});

it.skipIf(!available)('#6232 Align carries a selected hosted door once and refuses unsafe joined geometry atomically', async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  try {
    const wall = model.bim.store.addWall('alpha', 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 }).expressId;
    const door = model.bim.store.addHostedDoor('alpha', wall, { Offset: 1.5, Width: 1, Height: 2 }).expressId;
    const before = await graph(model), original = await extents(model, [1222, wall, door]);
    const aligned = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [wall, door], mode: 'centre' } });
    expect(aligned.isError, JSON.stringify(aligned)).not.toBe(true);
    const after = await extents(model, [1222, wall, door]);
    const delta = after.get(wall)!.lo[0] - original.get(wall)!.lo[0];
    expect(after.get(door)!.lo[0] - original.get(door)!.lo[0]).toBeCloseTo(delta, 4);
    expect(after.get(door)!.hi[0] - original.get(door)!.hi[0]).toBeCloseTo(delta, 4);
    expect((await call('mutation_undo', {})).isError).not.toBe(true);
    expect(await graph(model)).toEqual(before);
    const neighbour = model.bim.store.addWall('alpha', 42, { Start: [24,20,0], End: [24,24,0], Thickness: .2, Height: 3 }).expressId;
    model.bim.store.joinWalls('alpha', wall, neighbour);
    const unrelated = model.bim.store.addWall('alpha', 42, { Start: [40,20,0], End: [40,24,0], Thickness: .2, Height: 3 }).expressId;
    const editor = model.backend.ensureEditor(), view = editor.getMutationView();
    // True aliased IFC leaf: the joined neighbour's representation is also
    // consumed by an unrelated occurrence. Native mesh preparation succeeds.
    editor.setPositionalAttribute(unrelated, 6, String(new AnchorEntityReader(model.store, view).entity(neighbour)!.attributes[6]));
    const column = model.bim.store.addColumn('alpha', 42, { Position: [35,30,0], Width: .4, Depth: .4, Height: 3 }).expressId;
    const unsafeBefore = await graph(model), journal = structuredClone(view.getMutations()), allocator = view.peekNextExpressId();
    const refused = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [column,wall], mode: 'left' } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.message).toContain('shares placement or geometry');
    expect(await graph(model)).toEqual(unsafeBefore);
    expect(view.getMutations()).toEqual(journal);
    expect(view.peekNextExpressId()).toBe(allocator);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});

it.skipIf(!available)('#6232 stale native Align preparation preserves the intervening real edit', async () => {
  const { registry } = await liveToolSession(1), model = registry.get('alpha')!;
  try {
    const target = model.bim.store.addColumn('alpha', 42, { Position: [20,20,0], Width: .4, Depth: .4, Height: 3 }).expressId;
    const resolve = () => {
      const editor = model.backend.ensureEditor();
      return { modelId: model.id, store: model.store, editor, mutationView: editor.getMutationView(), ownerHistoryId: null };
    };
    let intervening: Awaited<ReturnType<typeof graph>> | undefined;
    const service = createAlignCommandBackend(resolve, async (source, storey, ids) => {
      const geometry = await provideHeadlessAlignGeometry(source, storey, ids);
      model.bim.store.transformElements('alpha', [target], { kind: 'move', delta: [0,2] });
      intervening = await graph(model);
      return geometry;
    }, {
      historyHead: () => resolve().mutationView.getMutations().map(m => m.id).join('|'),
      record: (_modelId, write) => {
        const current = resolve();
        return recordCompoundMutation(current.mutationView, mutationView => write({ ...current, mutationView, editor: new StoreEditor(current.store, mutationView) }));
      },
    });
    const before = await extents(model, [target]);
    await expect(service.alignElements('alpha', 1222, [target], 'left')).rejects.toThrow('model changed');
    expect(await graph(model)).toEqual(intervening);
    const after = await extents(model, [target]);
    expect(after.get(target)!.lo[0]).toBeCloseTo(before.get(target)!.lo[0], 4);
    expect(after.get(target)!.lo[1]).toBeCloseTo(before.get(target)!.lo[1] + 2, 4);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});

for (const schema of ['IFC4', 'IFC4X3']) it.skipIf(!available)(`#6232 native Align uses rotated storey metres in a millimetre ${schema} source variant`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-align-'));
  const { registry, call } = await liveToolSession(1);
  try {
    // Metamorphic Bonsai source: retain its original graph, vary declared
    // native length unit/schema, then author a real overlay storey rotation.
    const source = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8')
      .replace("FILE_SCHEMA(('IFC4'))", `FILE_SCHEMA(('${schema}'))`)
      .replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    const filename = join(directory, 'rotated-millimetres.ifc');
    await writeFile(filename, source);
    const model = await loadIfcModel(filename, { modelId: 'alpha' });
    registry.add(model);
    const editor = model.backend.ensureEditor(), reader = new AnchorEntityReader(model.store, editor.getMutationView());
    const refId = (value: unknown) => Number(String(value).slice(1));
    const placement = reader.entity(refId(reader.entity(42)!.attributes[5]))!;
    const axisId = refId(placement.attributes[1]);
    const direction = editor.addEntity('IFCDIRECTION', [[Math.cos(.6), Math.sin(.6), 0]]).expressId;
    editor.setPositionalAttribute(axisId, 3, `#${direction}`);
    const a = model.bim.store.addColumn('alpha', 42, { Position: [20,20,0], Width: .4, Depth: .6, Height: 3 }).expressId;
    const b = model.bim.store.addColumn('alpha', 42, { Position: [30,25,0], Width: .8, Depth: .3, Height: 3 }).expressId;
    const before = await graph(model), original = await extents(model, [1222,a,b]);
    expect(original.get(a)!.hi[0] - original.get(a)!.lo[0]).toBeCloseTo(.4, 4);
    const aligned = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [a,b], mode: 'right' } });
    expect(aligned.isError, JSON.stringify(aligned)).not.toBe(true);
    const after = await extents(model, [1222,a,b]);
    for (const id of [a,b]) {
      expect(after.get(id)!.hi[0]).toBeCloseTo(after.get(1222)!.hi[0], 4);
      expect(after.get(id)!.lo[1]).toBeCloseTo(original.get(id)!.lo[1], 4);
    }
    expect((await call('mutation_undo', {})).isError).not.toBe(true);
    expect(await graph(model)).toEqual(before);
  } finally {
    for (const loaded of registry.list()) loaded.backend.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(!available)('#6232 incompatible Align shifts cannot overwrite a shared neighbour endpoint', async () => {
  const { registry, call } = await liveToolSession(1), model = registry.get('alpha')!;
  try {
    const wall = (Start: [number,number,number], End: [number,number,number]) => model.bim.store.addWall('alpha', 42, { Start, End, Thickness: .2, Height: 3 }).expressId;
    const a = wall([20,20,0], [24,20,0]), b = wall([24,20,0], [24,24,0]), c = wall([28,20,0], [24,20,0]);
    model.bim.store.joinWalls('alpha', a, b);
    model.bim.store.joinWalls('alpha', c, b);
    const before = await graph(model), view = model.backend.getMutationView()!, journal = structuredClone(view.getMutations()), allocator = view.peekNextExpressId();
    const result = await call('edit_element_geometry', { operation: { kind: 'align', reference_id: 1222, express_ids: [a,c], mode: 'left' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toContain('shared joined endpoint');
    expect(await graph(model)).toEqual(before);
    expect(view.getMutations()).toEqual(journal);
    expect(view.peekNextExpressId()).toBe(allocator);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});

for (const relation of ['joined', 'hosted'] as const) for (const count of [1, 2]) it.skipIf(!available)(`#6232 already-aligned ${relation} target keeps its reference fixed while an independent root moves (${count} models)`, async () => {
  const { registry, call } = await liveToolSession(count), target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
  const peer = count === 2 ? registry.get('alpha')! : null;
  try {
    const wall = model.bim.store.addWall(target, 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 }).expressId;
    const reference = relation === 'joined' ? wall : model.bim.store.addHostedDoor(target, wall, { Offset: 2, Width: 1, Height: 2 }).expressId;
    const stationary = relation === 'hosted' ? wall : model.bim.store.addWall(target, 42, { Start: [24,20,0], End: [28,20,0], Thickness: .2, Height: 3 }).expressId;
    if (relation === 'joined') model.bim.store.joinWalls(target, reference, stationary);
    const mode = relation === 'joined' ? 'bottom' : 'centre', axis = relation === 'joined' ? 1 : 0;
    const edge = (box: { lo: number[]; hi: number[] }) => mode === 'bottom' ? box.lo[axis] : (box.lo[axis] + box.hi[axis]) / 2;
    const column = model.bim.store.addColumn(target, 42, { Position: [35,30,0], Width: .4, Depth: .4, Height: 3 }).expressId;
    const before = await graph(model), peerBefore = peer && await graph(peer), ids = [reference, stationary, column];
    const original = await extents(model, ids);
    expect(edge(original.get(stationary)!)).toBeCloseTo(edge(original.get(reference)!), 4);
    expect(edge(original.get(column)!)).not.toBeCloseTo(edge(original.get(reference)!), 4);
    const result = await call('edit_element_geometry', { model_id: target, operation: { kind: 'align', reference_id: reference, express_ids: [stationary, column], mode } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const after = await extents(model, ids), graphAfter = await graph(model);
    expect(after.get(reference)).toEqual(original.get(reference));
    expect(after.get(stationary)).toEqual(original.get(stationary));
    expect(edge(after.get(column)!)).toBeCloseTo(edge(original.get(reference)!), 4);
    const changed = new Set(graphAfter.filter(entity => JSON.stringify(entity) !== JSON.stringify(before.find(previous => previous.id === entity.id))).map(entity => entity.id));
    const reader = new AnchorEntityReader(model.store, model.backend.getMutationView() ?? null);
    for (const id of [reference, stationary]) {
      const placement = reader.entity(id)!.attributes[5];
      expect(changed.has(id)).toBe(false);
      expect(typeof placement).toBe('string');
      const placementId = Number(String(placement).slice(1));
      expect(changed.has(placementId)).toBe(false);
    }
    if (peer) expect(await graph(peer)).toEqual(peerBefore);
    expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
    expect(await graph(model)).toEqual(before);
    expect(await extents(model, ids)).toEqual(original);
    if (peer) expect(await graph(peer)).toEqual(peerBefore);
    // The same dependency remains protected when this root actually moves.
    const activeRefusal = await call('edit_element_geometry', { model_id: target, operation: { kind: 'align', reference_id: reference, express_ids: [stationary, column], mode: 'left' } });
    expect(activeRefusal.isError).toBe(true);
    expect(activeRefusal.structuredContent?.message).toContain(relation === 'joined' ? 'reference is joined' : 'reference would move');
    expect(await graph(model)).toEqual(before);
    expect(await extents(model, ids)).toEqual(original);
    if (peer) expect(await graph(peer)).toEqual(peerBefore);
  } finally { for (const loaded of registry.list()) loaded.backend.dispose(); }
});
