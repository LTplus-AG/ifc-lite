/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { beforeAll, it, expect } from 'vitest';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addWallToStore } from './wall';
import { addRoofToStore } from './roof';
import { addSlabToStore } from './slab';
import { setTopConstraintInStore } from './storey/storey-top-constraint';
import { translateProduct } from './edit/placement-core';
import { exportText, newStorey, meshWalls, insideMesh } from './wall-join-mesh.oracle';
let api: IfcAPI;
beforeAll(() => { initSync({ module: readFileSync(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) }); api = new IfcAPI(); });
it('a wall top meets both slopes of a gable underside and follows a roof lift (#9296)', async () => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 }).roofId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
  const check = (lift: number) => {
    const meshes = meshWalls(api, exportText(s)).get(wall) ?? [];
    expect(meshes.length).toBeGreaterThan(0);
    for (const y of [1, 3, 4, 5, 7]) {
      const z = 4 + lift + Math.min(y, 8 - y) * Math.tan(Math.PI / 6);
      expect(insideMesh(meshes, [5, y, z - .03]), `wall fills to the underside at y=${y}`).toBe(true);
      expect(insideMesh(meshes, [5, y, z + .03]), `wall stops at the underside at y=${y}`).toBe(false);
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
  expect(insideMesh(meshes, [5, 2, 4.68])).toBe(true);
  expect(insideMesh(meshes, [5, 2, 4.72])).toBe(false);
});
