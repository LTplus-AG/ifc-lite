/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, it, expect, describe } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { scaleWallQuantities, wallQuantitySetCount } from './storey/storey-level-write.js';
import { recordCompoundMutation, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addWallToStore } from './wall.js';
import { addRoofToStore } from './roof.js';
import { addSlabToStore } from './slab.js';
import { deriveBaseQuantitySet } from './base-quantities.js';
import { setTopConstraintInStore } from './storey/storey-top-constraint.js';
import { translateProduct } from './edit/placement-core.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { resizeWallInStore } from './wall-size-edit.js';
import { resizeRectangleWall } from './edit/wall-edit.js';
import { ROOF_ATTACHMENT } from './edit/wall-base-solid.js';
import { exportText, newStorey, meshWalls, insideMesh } from './wall-join-mesh.oracle.js';
const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
describe.skipIf(!existsSync(wasm))('roof attachments through the mesh kernel (build WASM to run)', () => {
let api: IfcAPI;
beforeAll(() => { initSync({ module: readFileSync(wasm) }); api = new IfcAPI(); });
it.each(['IFC4', 'IFC2X3', 'IFC4X3'] as const)('%s: a wall top meets both slopes of a gable underside and follows a roof lift (#9296)', async (schema) => {
  const s = await newStorey(schema);
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const check = (lift: number) => {
    const meshes = meshWalls(api, exportText(s)).get(wall) ?? [];
    expect(meshes.length).toBeGreaterThan(0);
    for (const y of [1, 3, 4, 5, 7]) {
      const z = 4 + lift + Math.min(y, 8 - y) * Math.tan(Math.PI / 6);
      expect(insideMesh(meshes, [5, z - .03, -y]), `wall fills to the underside at y=${y}`).toBe(true);
      expect(insideMesh(meshes, [5, z + .03, -y]), `wall stops at the underside at y=${y}`).toBe(false);
    }
  };
  check(0);
  expect(translateProduct(s.store, s.view, s.editor, roof, [0, 0, 1]).ok).toBe(true);
  check(1);
});
it('a slab attachment follows a direct target lift, not only a storey edit (#9296)', async () => {
  const s = await newStorey();
  const slab = addSlabToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .3, ExtrudedDirection: [0, 0, -1] }).slabId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [1, 2, 0], End: [9, 2, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'slab', slabId: slab });
  expect(translateProduct(s.store, s.view, s.editor, slab, [0, 0, 1]).ok).toBe(true);
  const meshes = meshWalls(api, exportText(s)).get(wall) ?? [];
  expect(insideMesh(meshes, [5, 4.68, -2])).toBe(true);
  expect(insideMesh(meshes, [5, 4.72, -2])).toBe(false);
});

it.each(['roof-first', 'wall-first'] as const)('moving a roof and attached wall together is independent of %s selection order (#9296)', async (order) => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0,0,4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6,0,Math.PI / 6,0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5,0,0], End: [5,8,0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const moved = transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor,
    selected: order === 'roof-first' ? [roof,wall] : [wall,roof], op: {kind: 'move',delta: [20,0]},
  });
  expect(moved.remesh).toEqual(expect.arrayContaining([roof,wall]));
  const parts = meshWalls(api, exportText(s)).get(wall) ?? [];
  for (const y of [1,4,7]) {
    const z = 4 + Math.min(y,8-y) * Math.tan(Math.PI / 6);
    expect(insideMesh(parts,[25,z-.03,-y])).toBe(true);
    expect(insideMesh(parts,[25,z+.03,-y])).toBe(false);
  }
  expect(insideMesh(parts,[5,1,-4])).toBe(false);
});

it('a roof lift and every attached cut undo as one operation (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const lift = recordCompoundMutation(s.view, view => translateProduct(s.store, view, new StoreEditor(s.store, view), roof, [0, 0, 1]));
  expect(lift.ok).toBe(true);
  expect(insideMesh(meshWalls(api, exportText(s)).get(wall) ?? [], [5, 7.28, -4])).toBe(true);
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('the roof and its wall must be one compound operation'); });
  const restored = meshWalls(api, exportText(s)).get(wall) ?? [];
  expect(insideMesh(restored, [5, 6.28, -4])).toBe(true);
  expect(insideMesh(restored, [5, 7.28, -4])).toBe(false);
});
it('a roof that does not cover the wall refuses without a partial resize (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 2, Depth: 2, Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI / 6) }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [1, 1, 0], End: [9, 1, 0], Height: 3, Thickness: .2 }).wallId;
  const count = s.view.getNewEntities().length;
  expect(() => setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof })).toThrow(/does not cover/);
  expect(s.view.getNewEntities().length).toBe(count);
  const meshes = meshWalls(api, exportText(s)).get(wall) ?? [];
  expect(insideMesh(meshes, [5, 2.98, -1])).toBe(true);
  expect(insideMesh(meshes, [5, 3.02, -1])).toBe(false);
});

});

it('roof cuts omit prism-only quantities rather than report the uncut envelope (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  expect(deriveBaseQuantitySet(s.store, s.view, wall)?.quantities.some(q => q.name === 'NetVolume')).toBe(true);
  s.editor.setEntityType(wall, 'IfcWallStandardCase');
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  expect.soft(s.editor.getEntityType(wall)).toBe('IfcWall'); // A Boolean CSG body is not a StandardCase extrusion.
  const quantities = deriveBaseQuantitySet(s.store, s.view, wall)?.quantities ?? [];
  expect(quantities.find(q => q.name === 'Length')?.value).toBe(8);
  expect.soft(quantities.some(q => ['Height', 'GrossSideArea', 'NetSideArea', 'GrossVolume', 'NetVolume'].includes(q.name))).toBe(false);
});

it('roof-cut quantity sets keep a numeric count and never use prism scaling (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0,0,4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6,0,Math.PI / 6,0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5,0,0], End: [5,8,0], Height: 3, Thickness: .2 }).wallId;
  // Explicit quantities retain the existing source/user policy. A roof cut cannot
  // infer their new values by multiplying the original rectangular prism.
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'NetVolume', 4.8, QuantityType.Volume);
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  expect.soft(wallQuantitySetCount(s.store, s.view, wall)).toBe(1);
  const before = structuredClone(s.view.getQuantitiesForEntity(wall));
  scaleWallQuantities(s.store, s.view, wall, 2);
  expect.soft(s.view.getQuantitiesForEntity(wall)).toEqual(before);
});

const GABLE = { Position: [0, 0, 4] as [number, number, number], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 };

it('retargeting a roof-cut wall to a roof without a footprint restores its planar top (#9296)', async () => {
  const s = await newStorey();
  const pitched = addRoofToStore(s.editor, s.anchor, GABLE).roofId;
  const flat = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 5], Width: 10, Depth: 8, Thickness: .25 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: pitched });
  expect(s.view.getPropertyValue(wall, ROOF_ATTACHMENT, 'Clipped')).toBe(true);
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: flat });
  expect(s.view.getPropertyValue(wall, ROOF_ATTACHMENT, 'Clipped'), 'the first roof\'s cut is gone').toBe(false);
  expect(deriveBaseQuantitySet(s.store, s.view, wall)?.quantities.some(q => q.name === 'NetVolume'), 'prism quantities apply again').toBe(true);
});

it('resizing a roof-cut wall refits its cut in the same edit (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, GABLE).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const signature = () => s.view.getPropertyValue(wall, ROOF_ATTACHMENT, 'Signature');
  const before = signature();
  const result = s.editor.runAtomic(draft => resizeWallInStore({ dataStore: s.store, view: draft.getMutationView(), editor: draft }, wall, [3, 0, 0], [3, 8, 0]));
  expect(result.ok).toBe(true);
  expect(result.ok ? result.walls : []).toContain(wall);
  const resized = signature();
  expect(resized, 'the cut was rebuilt for the moved wall').not.toBe(before);
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  expect(signature(), 'a fresh fit finds the stored cut already current').toBe(resized);
});

it('a resize the roof cannot cover is refused without writing, and the four-write resize refuses a cut wall (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, GABLE).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const before = s.view.getPropertyValue(wall, ROOF_ATTACHMENT, 'Signature');
  const count = s.view.getMutationCount();
  expect(() => s.editor.runAtomic(draft => resizeWallInStore({ dataStore: s.store, view: draft.getMutationView(), editor: draft }, wall, [5, 0, 0], [5, 20, 0]))).toThrow(/does not cover/);
  expect(s.view.getMutationCount()).toBe(count);
  expect(s.view.getPropertyValue(wall, ROOF_ATTACHMENT, 'Signature')).toBe(before);
  expect(resizeRectangleWall(s.store, s.view, s.editor, wall, [3, 0, 0], [3, 8, 0])).toMatchObject({ ok: false });
  expect(s.view.getMutationCount()).toBe(count);
});
