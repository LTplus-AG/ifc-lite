/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One type edit, one building (#9296 lane U3): editing a shared wall type's
 * layers regenerates every occurrence in one undo step, and the joined walls,
 * the hosted door's cut, the generated room and the quantities all agree,
 * on screen (the real wasm remesh), after Undo and Redo, and in the export.
 */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { IfcAPI } from '@ifc-lite/wasm';
import { previewTypeLayerImpact, typeLayerScopeInStore } from '@ifc-lite/create';
import { configureMutationView } from '@/utils/configureMutationView';
import { isEditedQuantityRefreshEnabled } from '@/lib/quantities/edited-quantity-refresh';
import { applyAuthoredDefaults } from '@/lib/commands/modeling/authored-defaults';
import type { MeshData } from '@ifc-lite/geometry';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { applyMaterialLayers, createElementType, setElementType, type LayerFollow } from '@/components/viewer/model-inspector/inspector-edits';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { act } from 'react';
import { cleanup, click, render, type } from '@/test/render.js';
import { LayersSection } from '@/components/viewer/model-inspector/LayersSection';
import { toast } from '@/components/ui/toast';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { MODEL, requests, seedNativeSdkModel as seed, nativeSdkMeshes as meshes, nativeSdkUndoDepth as depth } from '@/test/native-sdk-model';

afterEach(() => { cleanup(); setRemeshClientFactory(null); });

const s = useViewerStore.getState;
const STOREY = 42;
/** The sample's IfcWallType WAL100 (one 0.1 m layer) and its wall, a parsed arbitrary-profile body. */
const NATIVE_TYPE = 388, NATIVE_WALL = 1222;

/** Let every remesh the edit asked for land: the fixture's worker answers on a microtask. */
async function landed(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function extents(list: readonly MeshData[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of list) for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], mesh.positions[i + a]); max[a] = Math.max(max[a], mesh.positions[i + a]); }
  }
  return { min, max };
}
/** A straight wall's rendered plan size (viewer Y is up): the short side is its thickness. */
function planSize(list: readonly MeshData[]): { thickness: number; length: number } {
  const { min, max } = extents(list);
  const sides = [max[0] - min[0], max[2] - min[2]].sort((a, b) => a - b);
  return { thickness: sides[0], length: sides[1] };
}
/** Whether any face of `list`, seen along the wall's thickness (viewer Z), covers the point: a door cut through the full thickness leaves none. */
function faceCovers(list: readonly MeshData[], x: number, y: number): boolean {
  for (const mesh of list) {
    const p = mesh.positions, idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const area = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]);
      if (Math.abs(area) < 1e-9) continue; // a face along the thickness (a jamb) covers nothing
      const side = (u: number, v: number) => (p[v] - p[u]) * (y - p[u + 1]) - (x - p[u]) * (p[v + 1] - p[u + 1]);
      const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)];
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
    }
  }
  return false;
}
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 1e-3, `${what}: ${actual} ≠ ${expected}`);
const exported = () => new TextDecoder().decode(editedModelBytes(s().models.get(MODEL)!.ifcDataStore!, s().mutationViews.get(MODEL) ?? null));
/** Property and quantity sets are written from the view on every export, with fresh ids and GlobalIds; every other record keeps its own. */
const SYNTHESISED = /^#\d+=(IFCPROPERTYSINGLEVALUE|IFCPROPERTYSET|IFCRELDEFINESBYPROPERTIES|IFCQUANTITY[A-Z]+|IFCELEMENTQUANTITY)\(/;
const comparable = (step: string) => step.split('\n').filter(line => !line.startsWith('FILE_NAME'))
  .map(line => SYNTHESISED.test(line) ? line.replace(/#\d+/g, '#').replace(/'[0-9A-Za-z_$]{22}'/g, "'GlobalId'") : line).sort();

/** Each IfcRelDefinesByType in a STEP text: its RelatingType and RelatedObjects. */
function typeRelations(step: string): Array<{ type: number; objects: number[] }> {
  return [...step.matchAll(/^#\d+=IFCRELDEFINESBYTYPE\('[^']*',[^,]*,[^,]*,[^,]*,\(([^)]*)\),#(\d+)\);$/gm)]
    .map(m => ({ type: Number(m[2]), objects: m[1].split(',').map(ref => Number(ref.trim().slice(1))) }));
}
/** Every type has exactly one IfcRelDefinesByType, and `typeId`'s covers exactly `occurrences`. */
function oneRelationPerType(step: string, typeId: number, occurrences: readonly number[]): void {
  const rels = typeRelations(step);
  const perType = new Map<number, number>();
  for (const rel of rels) perType.set(rel.type, (perType.get(rel.type) ?? 0) + 1);
  for (const [type, count] of perType) assert.equal(count, 1, `#${type} has ${count} IfcRelDefinesByType`);
  assert.deepEqual(rels.find(rel => rel.type === typeId)?.objects.sort((x, y) => x - y), [...occurrences].sort((x, y) => x - y));
}
/** IfcShapeRepresentation records nothing references (IfcShapeModel.WR11 needs a product shape, map or aspect to own each one). */
function orphanRepresentations(step: string): string[] {
  const lines = step.split('\n');
  return lines.filter(line => line.includes('=IFCSHAPEREPRESENTATION(')).map(line => /^#(\d+)=/.exec(line)![1])
    .filter(id => !lines.some(line => !line.startsWith(`#${id}=`) && new RegExp(`#${id}(?![0-9])`).test(line.replace(/^#\d+=/, ''))));
}
function effectiveGuid(id: number): string {
  const guid = s().mutationViews.get(MODEL)!.getNewEntity(id)?.attributes[0];
  assert.equal(typeof guid, 'string');
  return guid as string;
}

/**
 * The acceptance model: a closed 6 x 4 m enclosure of four joined walls and a
 * partition at x = 3 m, all five of ONE layered wall type, a door hosted in the
 * south wall, and the two generated rooms. The south wall is drawn the way the
 * Wall tool draws with the inspector's defaults (a type picked and a layer
 * default active), so it carries its own layer set usage; the others are typed
 * in the inspector.
 */
async function acceptanceModel() {
  const { adapter } = await seed();
  configureMutationView(s().mutationViews.get(MODEL)!, s().models.get(MODEL)!.ifcDataStore!);
  const corners: [number, number, number][] = [[20, 20, 0], [26, 20, 0], [26, 24, 0], [20, 24, 0]];
  const enclosure = corners.map((Start, i) => adapter.addWall(MODEL, STOREY, { Start, End: corners[(i + 1) % 4], Thickness: i === 0 ? .23 : .2, Height: 3 }).expressId);
  for (let i = 0; i < 4; i++) adapter.joinWalls!(MODEL, enclosure[i], enclosure[(i + 1) % 4], {});
  const partition = adapter.addWall(MODEL, STOREY, { Start: [23, 20, 0], End: [23, 24, 0], Thickness: .2, Height: 3 }).expressId;
  const walls = [...enclosure, partition];
  adapter.addHostedDoor!(MODEL, enclosure[0], { Offset: 1.5, Width: .9, Height: 2.1 });
  const generated = s().generateSpacesFromWalls(MODEL, STOREY, {});
  assert.ok(!('error' in generated) && generated.emitted.length === 2, 'two generated rooms either side of the partition');
  const rooms = generated.emitted.map(e => e.result.spaceId);
  // Defaults: type WT-230 picked, and 230 mm Brick layers applied to "Element" (the next walls).
  const type = createElementType(MODEL, 'wall', 'WT-230');
  assert.ok(type !== null);
  const layerDefault = applyMaterialLayers(MODEL, { kind: 'wall', target: 'element', typeId: null, layers: [{ thickness: .23, material: { name: 'Brick' } }] });
  assert.ok(layerDefault !== null);
  s().setAuthoringDefaults({ typeIds: { wall: { modelId: MODEL, expressId: type } }, layerSetIds: { wall: { modelId: MODEL, expressId: layerDefault } } });
  // The hook every modelling command runs on what it just drew, in the same undo step.
  applyAuthoredDefaults(useViewerStore, MODEL, [walls[0]]);
  s().setAuthoringDefaults({ typeIds: {}, layerSetIds: {} });
  // One inspector edit at a time, each drawn before the next, as a user types them.
  for (const wall of walls.slice(1)) {
    assert.equal(setElementType(MODEL, wall, type), true);
    await landed();
  }
  return { walls, rooms, type };
}

/** What the acceptance loop reads, on screen and in the model, after each step. */
function readings(walls: readonly number[], rooms: readonly number[]) {
  const target = () => modelEditTarget(s(), MODEL)!;
  const of = (id: number) => meshes().filter(mesh => mesh.expressId === id);
  return {
    thickness: () => walls.map(id => readWallMetres(target(), id)?.thickness),
    rendered: () => walls.map(id => planSize(of(id)).thickness),
    bodyLength: (id: number) => planSize(of(id)).length,
    /** Each enclosure corner's join, from the walls' IFC bodies: [the end cut of one wall, the start cut of the next], left and right faces. */
    corners: () => walls.slice(0, 4).map((id, i) => {
      const here = readWallMetres(target(), id)?.read?.wall, next = readWallMetres(target(), walls[(i + 1) % 4])?.read?.wall;
      return [here?.endCut, next?.startCut];
    }),
    netArea: () => rooms.map(id => s().mutationViews.get(MODEL)!.getQuantitiesForEntity(id)
      .find(set => set.name === 'Qto_SpaceBaseQuantities')?.quantities.find(q => q.name === 'NetFloorArea')?.value),
    /** Qto_WallBaseQuantities as the viewer's quantity reader gives them (the Properties panel and the export read the same). */
    wallQto: (id: number) => Object.fromEntries((s().mutationViews.get(MODEL)!.getQuantitiesForEntity(id)
      .find(set => set.name === 'Qto_WallBaseQuantities')?.quantities ?? []).map(q => [q.name, q.value])),
    /**
     * The door wall's own mesh, seen through its thickness at door height: open
     * 1.5 m from its middle on the door's side, solid on the other. (A remeshed
     * element's positions are local to it, so this is read within the one mesh.)
     */
    doorHole: () => {
      const wall = of(walls[0]), { min, max } = extents(wall), y = min[1] + 1.05, mid = (min[0] + max[0]) / 2;
      return [mid - 1.5, mid + 1.5].map(x => faceCovers(wall, x, y));
    },
  };
}

/** Everything the loop asserts for a building whose shared type is `t` metres thick. */
function assertBuilding(r: ReturnType<typeof readings>, walls: readonly number[], t: number, label: string): void {
  assert.deepEqual(r.thickness(), walls.map(() => t), `${label}: every wall of the type is ${t} m in IFC`);
  r.rendered().forEach((v, i) => near(v, t, `${label}: wall ${i} is drawn ${t} m thick`));
  // A closed butt join: one wall runs on by half the other's thickness, the other stops at its face.
  r.corners().forEach(([end, start], i) => {
    const cuts = [end?.left, end?.right, start?.left, start?.right];
    assert.ok(cuts.every(c => c !== undefined), `${label}: corner ${i} has both joined bodies`);
    assert.ok(Math.abs(cuts[0]! - cuts[1]!) < 1e-9 && Math.abs(cuts[2]! - cuts[3]!) < 1e-9, `${label}: corner ${i} cuts square`);
    assert.deepEqual([cuts[0]!, cuts[2]!].map(c => Math.round(c * 1e6) / 1e6).sort((x, y) => x - y), [-t / 2, t / 2], `${label}: corner ${i} is closed at ${t} m`);
  });
  assert.deepEqual(r.doorHole().sort(), [false, true], `${label}: the door is cut through the full ${t} m wall`);
  // Each room is 3 m by 4 m between axes, inside half a wall on every side.
  r.netArea().forEach(area => near(area!, (3 - t) * (4 - t), `${label}: a room's net area`));
  const qto = r.wallQto(walls[0]);
  near(qto.Width!, t, `${label}: the wall quantities read the new width`);
  near(qto.GrossVolume!, t * r.bodyLength(walls[0]) * 3, `${label}: gross volume is the drawn body's width x length x height`);
  assert.ok(qto.NetVolume! < qto.GrossVolume! - .9 * 2.1 * t + 1e-3, `${label}: net volume deducts the door`);
}

it('editing the shared type of five walls regenerates them, the door cut, the joins, both rooms and the quantities; Undo, Redo, export and a fresh session agree (#9296)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { walls, rooms, type } = await acceptanceModel();
  const r = readings(walls, rooms);
  const target = () => modelEditTarget(s(), MODEL)!;
  assertBuilding(r, walls, .23, 'typed at 230 mm');
  assert.deepEqual([...typeLayerScopeInStore(target(), type).inheriting].sort(), [...walls].sort(), 'all five follow the type, the one drawn with its own usage too');
  const before = exported(), undoBefore = depth();
  oneRelationPerType(before, type, walls);

  // The impact the type UI can show before Apply: computed, never applied.
  const impact = previewTypeLayerImpact(target(), type, .3);
  assert.deepEqual(comparable(exported()), comparable(before), 'the preview applies nothing');
  assert.deepEqual(impact.resized.map(x => x.id).sort(), [...walls].sort());
  assert.deepEqual(impact.differing, []);
  assert.deepEqual(impact.rooms.map(x => x.id).sort(), [...rooms].sort());
  impact.rooms.forEach(room => near(room.netFloorArea.after!, 2.7 * 3.7, 'the preview predicts each room\'s new net area'));

  // 1. 230 -> 300 mm through a type edit.
  requests.length = 0;
  let follow: LayerFollow | null = null;
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', elementId: walls[1], typeId: type,
    layers: [{ thickness: .3, material: { name: 'Brick' } }] }, f => { follow = f; }) !== null);
  await landed();
  const ops = s().undoStacks.get(MODEL)!.slice(undoBefore);
  assert.equal(new Set(ops.map(op => s().mutationBatchTags.get(op.id))).size, 1, 'the type edit is one undo step');
  assert.deepEqual(follow, { refused: [], notices: [] }, 'every dependent followed');
  assertBuilding(r, walls, .3, 'after the type edit');
  const remeshed = new Set(requests.flatMap(request => [...request.targets]));
  for (const id of [...walls, ...rooms, ...impact.remesh]) assert.ok(remeshed.has(id), `#${id} was re-meshed by the edit itself`);
  const edited = exported();
  oneRelationPerType(edited, type, walls);
  assert.deepEqual(orphanRepresentations(edited), [], 'every representation the edit wrote belongs to a product');

  // 2. Undo, then Redo.
  s().undo(MODEL);
  await landed();
  assertBuilding(r, walls, .23, 'after Undo');
  assert.deepEqual(comparable(exported()), comparable(before), 'Undo restores the model exactly');
  s().redo(MODEL);
  await landed();
  assertBuilding(r, walls, .3, 'after Redo');
  assert.deepEqual(comparable(exported()), comparable(edited), 'Redo restores the edit exactly');

  // 3. The export, meshed on its own: the bodies, not the labels.
  const bytes = new TextEncoder().encode(edited);
  const guids = { type: effectiveGuid(type), walls: walls.map(effectiveGuid), rooms: rooms.map(effectiveGuid) };
  const api = new IfcAPI();
  try {
    applyRemeshConfig(api, { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true });
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    const ids = guids.walls.map(guid => parsed.entities.getExpressIdByGlobalId(guid));
    const meshed = remeshOnApi(api, { buffer: bytes, targets: Uint32Array.from(ids), frame: { x: 0, y: 0, z: 0, needsShift: false }, ...styleWireOnApi(api, bytes) }).meshes;
    ids.forEach((id, i) => near(planSize(meshed.filter(mesh => mesh.expressId === id)).thickness, .3, `the exported body of wall ${i} is 300 mm`));
  } finally {
    api.free();
  }

  // 4. Reopen the export in a fresh session and edit the shared type again.
  await seed(bytes);
  const reopened = s().models.get(MODEL)!.ifcDataStore!;
  configureMutationView(s().mutationViews.get(MODEL)!, reopened);
  // The reopened walls are LOADED and carry the Qto_WallBaseQuantities the export wrote. The type edit itself
  // must refresh them, with "Update quantities of edited elements" left at its default (off).
  assert.equal(isEditedQuantityRefreshEnabled(), false);
  const id = (guid: string) => reopened.entities.getExpressIdByGlobalId(guid);
  const [type2, walls2, rooms2] = [id(guids.type), guids.walls.map(id), guids.rooms.map(id)];
  oneRelationPerType(exported(), type2, walls2);
  const r2 = readings(walls2, rooms2);
  assert.deepEqual(r2.thickness(), walls2.map(() => .3), 'the reopened walls are 300 mm');
  walls2.forEach(wall => near(r2.wallQto(wall).Width!, .3, 'the reopened walls carry the exported 300 mm Qto'));
  assert.deepEqual([...typeLayerScopeInStore(modelEditTarget(s(), MODEL)!, type2).inheriting].sort(), [...walls2].sort(), 'after reopen, all five still follow the type');
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', elementId: walls2[2], typeId: type2,
    layers: [{ thickness: .25, material: { name: 'Brick' } }] }) !== null);
  await landed();
  assertBuilding(r2, walls2, .25, 'edited again after reopen');
  walls2.forEach(wall => near(r2.wallQto(wall).Width!, .25, 'every reopened wall\'s stored Qto Width follows'));
  const reopenedEdit = exported();
  s().undo(MODEL);
  await landed();
  assertBuilding(r2, walls2, .3, 'Undo after reopen');
  walls2.forEach(wall => near(r2.wallQto(wall).Width!, .3, 'Undo restores the stored Qto'));
  s().redo(MODEL);
  await landed();
  assertBuilding(r2, walls2, .25, 'Redo after reopen');
  assert.deepEqual(comparable(exported()), comparable(reopenedEdit), 'Redo after reopen restores the edit exactly');
  oneRelationPerType(reopenedEdit, type2, walls2);
  assert.deepEqual(orphanRepresentations(reopenedEdit), [], 'editing the loaded walls replaces their file axes without leaving them unowned');
});

it('an occurrence whose body cannot follow its type keeps it and is named, while the others still follow (#9296)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter } = await seed();
  const authored = adapter.addWall(MODEL, STOREY, { Start: [20, 20, 0], End: [24, 20, 0], Thickness: .2, Height: 3 }).expressId;
  // Typing a wall with the sample's 100 mm layered type sizes it to the type.
  assert.equal(setElementType(MODEL, authored, NATIVE_TYPE), true);
  assert.equal(readWallMetres(modelEditTarget(s(), MODEL)!, authored)?.thickness, .1);
  const nativeBefore = JSON.stringify(meshes().filter(mesh => mesh.expressId === NATIVE_WALL).map(mesh => [...mesh.positions]));
  // Through the inspector's own Layers section: the count before Apply, the notice after.
  const ui = render(<LayersSection modelId={MODEL} live={modelEditTarget(s(), MODEL)!} kind="wall" initial={[{ materialId: null, thickness: .1 }]}
    inheritedFromType elementId={authored} typeId={NATIVE_TYPE} defaultThickness={.2} />);
  act(() => click([...ui.querySelectorAll('input[type="radio"]')].find(el => el.closest('label')?.textContent === 'Type')!));
  assert.match(ui.textContent ?? '', /Changes 2 elements of this type/);
  type(ui.querySelector<HTMLInputElement>('input[aria-label="Layer 1 thickness in metres"]')!, '0.25');
  act(() => click(ui.querySelector('[data-inspector-apply-layers]')!));
  await landed();
  assert.equal(readWallMetres(modelEditTarget(s(), MODEL)!, authored)?.thickness, .25, 'the resizable occurrence follows');
  const notice = ui.querySelector('[data-inspector-layer-refusals]');
  assert.ok(notice, 'the occurrence that could not follow is shown, not skipped silently');
  assert.match(notice.textContent ?? '', /1 element kept its previous body/);
  assert.match(notice.textContent ?? '', /Wall: .*IfcRectangleProfileDef/, 'named, with the reason');
  assert.equal(JSON.stringify(meshes().filter(mesh => mesh.expressId === NATIVE_WALL).map(mesh => [...mesh.positions])), nativeBefore, 'and it keeps the body it had');
});

it('a reviewed typing whose element cannot follow its layered type names it, as the inspector does (#9296)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter } = await seed();
  const authored = adapter.addWall(MODEL, STOREY, { Start: [20, 20, 0], End: [24, 20, 0], Thickness: .2, Height: 3 }).expressId;
  const layered = createElementType(MODEL, 'wall', 'WT-300', authored);
  assert.ok(layered !== null);
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', elementId: authored, typeId: layered, layers: [{ thickness: .3, material: null }] }) !== null);
  await landed();
  const errors: string[] = [];
  mock.method(toast, 'error', (message: string) => { errors.push(message); });
  t.after(() => mock.restoreAll());
  // Retype the sample's arbitrary-profile wall onto the 300 mm layered type through a reviewed proposal.
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Retype', units: 'm', frame: 'storey-local',
    operations: [{ op: 'type.assign', target: { globalId: '2JUHrTM_j3UxZiBnyBfByx', ifcClass: 'IfcWall', name: 'Wall' }, expected: 'WAL100',
      type: { globalId: effectiveGuid(layered), name: 'WT-300' } }] }));
  const preview = previewModelAuthoring(s(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(errors.length, 1, 'one notice for the row');
  assert.match(errors[0], /1 element kept its previous body/);
  assert.match(errors[0], /Wall: .*IfcRectangleProfileDef/, 'it names the wall and the reason');
});

it('a scripted typing (bim.store.assignType) re-meshes the joined walls its layered type re-trims (#9296)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter } = await seed();
  const a = adapter.addWall(MODEL, STOREY, { Start: [20, 20, 0], End: [24, 20, 0], Thickness: .2, Height: 3 }).expressId;
  const b = adapter.addWall(MODEL, STOREY, { Start: [24, 20, 0], End: [24, 23, 0], Thickness: .2, Height: 3 }).expressId;
  adapter.joinWalls!(MODEL, a, b, {});
  const type = createElementType(MODEL, 'wall', 'WT-300');
  assert.ok(type !== null);
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', typeId: type, layers: [{ thickness: .3, material: null }] }) !== null);
  await landed();
  requests.length = 0;
  adapter.assignType!(MODEL, type, [a]);
  await landed();
  assert.equal(readWallMetres(modelEditTarget(s(), MODEL)!, a)?.thickness, .3, 'the script typed the wall to 300 mm');
  const remeshed = new Set(requests.flatMap(request => [...request.targets]));
  assert.ok(remeshed.has(a) && remeshed.has(b), 'the typed wall and the wall it re-trimmed are re-meshed');
  near(planSize(meshes().filter(mesh => mesh.expressId === a)).thickness, .3, 'and drawn at 300 mm');
});
