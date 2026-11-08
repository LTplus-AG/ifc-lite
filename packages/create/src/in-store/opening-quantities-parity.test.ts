/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../index.js';
import { parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';

it.each(['IFC4', 'IFC2X3'] as const)('derives door and window dimensions from live OverallWidth/Height (#9354), %s', async Schema => {
  const c = new IfcCreator({ Schema });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  for (const type of ['IfcDoor', 'IfcWindow']) {
    const id = editor.addEntity(type, ['0Door_A_00000000000001', null, 'D1', null, null, null, null, 'D-01', 2.1, .9]).expressId;
    const values = () => Object.fromEntries(deriveAuthoredBaseQuantities(store, view, id)[0]?.quantities.map(q => [q.name, q.value]) ?? []);
    expect(values()).toMatchObject({ Width: .9, Height: 2.1, Area: 1.89 });
    editor.setPositionalAttribute(id, 9, 1.2);
    expect(values()).toMatchObject({ Width: 1.2, Area: 2.52 });
  }
});

it.each(['IFC4', 'IFC2X3'] as const)('measures a grid column without offering writable placement (%s, #9354)', async Schema => {
  const { addColumnOnGridToStore } = await import('./grid-column.js');
  const { addGridToStore } = await import('./grid.js');
  const { resolveSpatialAnchor } = await import('./resolve-anchor.js');
  const { resolveLinearElementChain } = await import('./edit/linear-element-edit.js');
  const c = new IfcCreator({ Schema });
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const grid = addGridToStore(editor, anchor, {
    UAxes: [{ Tag: 'A', Start: [0, -1], End: [0, 4] }],
    VAxes: [{ Tag: '1', Start: [-1, 0], End: [4, 0] }],
  });
  const col = addColumnOnGridToStore(editor, store, anchor, { Position: [0, 0, 0], Width: .3, Depth: .4, Height: 3 }, {
    GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[0], grid.vAxisIds[0]],
  });
  expect(resolveLinearElementChain(store, view, editor, col.columnId)).toBeNull();
  const q = Object.fromEntries(deriveAuthoredBaseQuantities(store, view, col.columnId)[0]?.quantities.map(q => [q.name, q.value]) ?? []);
  expect(q).toMatchObject({ Length: 3, CrossSectionArea: .12, NetVolume: .36 });
});

it('measures authored stair and curtain wall assemblies (#9354)', async () => {
  const { addStairToStore } = await import('./stair.js');
  const { addCurtainWallToStore } = await import('./curtain-wall.js');
  const { resolveSpatialAnchor } = await import('./resolve-anchor.js');
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const stair = addStairToStore(editor, anchor, { Position: [0, 0, 0], Width: 1, NumberOfRisers: 10, RiserHeight: .2, TreadLength: .3 });
  const curtain = addCurtainWallToStore(editor, anchor, { Start: [0, 0, 0], End: [6, 0, 0], Height: 3, UGrid: 2, VGrid: 2 });
  const values = (id: number) => Object.fromEntries(deriveAuthoredBaseQuantities(store, view, id)[0]?.quantities.map(q => [q.name, q.value]) ?? []);
  expect(values(stair.stairId)).toMatchObject({ Length: 3, GrossVolume: 3.3, NetVolume: 3.3 });
  expect(values(curtain.curtainWallId)).toMatchObject({ Height: 3, GrossSideArea: 18 });
  expect(values(curtain.curtainWallId).NetVolume).toBeGreaterThan(0);
});
