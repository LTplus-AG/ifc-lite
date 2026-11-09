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
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { IfcAPI } from '@ifc-lite/wasm';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { deriveAuthoredBaseQuantities, previewTypeLayerImpact } from '@ifc-lite/create';
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

/** Two walls of one 230 mm layered type (one hosting a door), two plain walls joined round them, and the generated room they enclose. */
async function acceptanceModel() {
  const { adapter, store } = await seed();
  const corners: [number, number, number][] = [[20, 20, 0], [26, 20, 0], [26, 24, 0], [20, 24, 0]];
  const walls = corners.map((Start, i) => adapter.addWall(MODEL, STOREY, { Start, End: corners[(i + 1) % 4], Thickness: .2, Height: 3 }).expressId);
  for (let i = 0; i < 4; i++) adapter.joinWalls!(MODEL, walls[i], walls[(i + 1) % 4], {});
  const door = adapter.addHostedDoor!(MODEL, walls[0], { Offset: 3, Width: .9, Height: 2.1 }).expressId;
  const generated = s().generateSpacesFromWalls(MODEL, STOREY, {});
  assert.ok(!('error' in generated) && generated.emitted.length === 1, 'one generated room');
  const room = generated.emitted[0].result.spaceId;
  const type = createElementType(MODEL, 'wall', 'WT-230', walls[0]);
  assert.ok(type !== null);
  assert.equal(setElementType(MODEL, walls[1], type), true);
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', elementId: walls[0], typeId: type, layers: [{ thickness: .23, material: { name: 'Brick' } }] }) !== null);
  await landed();
  return { store, walls, door, room, type };
}

it('editing a shared wall type to 300 mm regenerates both walls, the cut, the joins and the room, and Undo and Redo restore it exactly (#9296)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { walls, door, room, type } = await acceptanceModel();
  const target = () => modelEditTarget(s(), MODEL)!;
  const thickness = () => walls.map(id => readWallMetres(target(), id)?.thickness);
  const rendered = (id: number) => planSize(meshes().filter(mesh => mesh.expressId === id));
  const netArea = () => s().mutationViews.get(MODEL)!.getQuantitiesForEntity(room)
    .find(set => set.name === 'Qto_SpaceBaseQuantities')?.quantities.find(q => q.name === 'NetFloorArea')?.value;
  const wallWidth = (id: number) => deriveAuthoredBaseQuantities(s().models.get(MODEL)!.ifcDataStore!, s().mutationViews.get(MODEL)!, id)
    .find(set => set.name === 'Qto_WallBaseQuantities')?.quantities.find(q => q.name === 'Width')?.value;
  const doorCentre = () => {
    const { min, max } = extents(meshes().filter(mesh => mesh.expressId === door));
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] as const;
  };
  const cutThrough = () => !faceCovers(meshes().filter(mesh => mesh.expressId === walls[0]), ...doorCentre());

  assert.deepEqual(thickness(), [.23, .23, .2, .2]);
  near(rendered(walls[0]).thickness, .23, 'the typed wall is drawn 230 mm thick');
  near(rendered(walls[3]).length, 4 - .1 + .115, 'the joined west wall runs to the typed wall\'s outer face');
  near(netArea()!, 5.785 * 3.785, 'the room is the net area inside the 230 and 200 mm faces');
  assert.ok(cutThrough(), 'the door is cut through the 230 mm wall');
  const before = exported(), undoBefore = depth();

  // The impact preview the type UI can show before Apply: computed, never applied.
  const impact = previewTypeLayerImpact(target(), type, .3);
  assert.deepEqual(comparable(exported()), comparable(before), 'the preview applies nothing');
  assert.deepEqual(impact.resized.map(r => [r.id, r.from, r.to]), [[walls[0], .23, .3], [walls[1], .23, .3]]);
  assert.deepEqual(new Set(impact.joined), new Set([walls[2], walls[3]]));
  assert.deepEqual(impact.rooms.map(r => r.id), [room]);
  near(impact.rooms[0].netFloorArea.after!, 5.75 * 3.75, 'the preview predicts the room\'s new net area');

  requests.length = 0;
  let follow: LayerFollow | null = null;
  assert.ok(applyMaterialLayers(MODEL, { kind: 'wall', target: 'type', elementId: walls[0], typeId: type,
    layers: [{ thickness: .3, material: { name: 'Brick' } }] }, f => { follow = f; }) !== null);
  await landed();
  const ops = s().undoStacks.get(MODEL)!.slice(undoBefore);
  assert.ok(ops.length > 0);
  assert.equal(new Set(ops.map(op => s().mutationBatchTags.get(op.id))).size, 1, 'the type edit is one undo step');
  assert.deepEqual(follow, { refused: [], notices: [] }, 'every dependent followed');
  const after = () => {
    assert.deepEqual(thickness(), [.3, .3, .2, .2], 'both occurrences take the type, the plain walls keep theirs');
    near(rendered(walls[0]).thickness, .3, 'the door wall is redrawn 300 mm thick');
    near(rendered(walls[1]).thickness, .3, 'the second typed wall is redrawn 300 mm thick');
    near(rendered(walls[3]).length, 4 - .1 + .15, 'the joined west wall runs on to the new outer face, on screen');
    near(rendered(walls[2]).length, 6 - .15 + .1, 'the joined north wall stops at the new inner face, on screen');
    assert.ok(cutThrough(), 'the door stays cut through the full 300 mm');
    near(netArea()!, 5.75 * 3.75, 'the generated room shrinks to the net area inside the new faces');
    near(wallWidth(walls[0])!, .3, 'the wall quantities read the new width');
  };
  after();
  const remeshed = new Set(requests.flatMap(request => [...request.targets]));
  for (const id of [...walls, room]) assert.ok(remeshed.has(id), `#${id} was re-meshed by the edit itself`);
  for (const id of impact.remesh) assert.ok(remeshed.has(id), `#${id}, previewed, was re-meshed`);
  const edited = exported();

  s().undo(MODEL);
  await landed();
  assert.deepEqual(thickness(), [.23, .23, .2, .2]);
  near(rendered(walls[3]).length, 4 - .1 + .115, 'Undo redraws the joined wall too');
  near(rendered(walls[0]).thickness, .23, 'Undo redraws the typed wall');
  near(netArea()!, 5.785 * 3.785, 'Undo restores the room');
  assert.deepEqual(comparable(exported()), comparable(before), 'Undo restores the model exactly');

  s().redo(MODEL);
  await landed();
  after();
  assert.deepEqual(comparable(exported()), comparable(edited), 'Redo restores the edit exactly');

  // The export, reopened and meshed on its own: the bodies, not the labels.
  const bytes = new TextEncoder().encode(edited);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(parsed.properties ?? null, 'reopened');
  const reopened = walls.map(id => parsed.entities.getExpressIdByGlobalId(effectiveGuid(id)));
  assert.deepEqual(reopened.map(id => readWallMetres({ dataStore: parsed, view, editor: new StoreEditor(parsed, view) }, id)?.thickness), [.3, .3, .2, .2]);
  const api = new IfcAPI();
  try {
    applyRemeshConfig(api, { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true });
    const frame = { x: 0, y: 0, z: 0, needsShift: false };
    const meshedExport = remeshOnApi(api, { buffer: bytes, targets: Uint32Array.from(reopened), frame, ...styleWireOnApi(api, bytes) }).meshes;
    const of = (id: number) => meshedExport.filter(mesh => mesh.expressId === id);
    near(planSize(of(reopened[0])).thickness, .3, 'the exported door wall body is 300 mm');
    near(planSize(of(reopened[1])).thickness, .3, 'the exported second typed wall body is 300 mm');
    near(planSize(of(reopened[3])).length, 4 - .1 + .15, 'the exported joined wall body meets the new face');
  } finally {
    api.free();
  }
});

function effectiveGuid(id: number): string {
  const guid = s().mutationViews.get(MODEL)!.getNewEntity(id)?.attributes[0];
  assert.equal(typeof guid, 'string');
  return guid as string;
}

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
