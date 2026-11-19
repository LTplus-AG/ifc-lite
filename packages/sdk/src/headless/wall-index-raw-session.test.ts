/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { openModel } from '../headless.js';

afterEach(() => vi.restoreAllMocks());

for (const count of [16, 64]) it(`#9406 first ordinary wall after ${count} public raw walls does not reread the unrelated walls`, async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const session = await openModel(new TextEncoder().encode(creator.toIfc().content), { disableWorkerScan: true });
  try {
    const S = session.bim.store, M = session.bim.model.activeId()!;
    const anchor = resolveSpatialAnchor(session.store, level);
    // The anchored builder only calls addEntity. Forward each call through
    // the actual SDK raw API, as scripts constructing IFC subgraphs do.
    const writer = { addEntity: (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) =>
      S.addEntity(M, { type, attributes }) } as unknown as StoreEditor;
    const params = (i: number) => ({ Start: [i * 10, 0, 0] as [number, number, number],
      End: [i * 10 + 4, 0, 0] as [number, number, number], Height: 3, Thickness: .2 });
    const previous = new Set<number>();
    for (let i = 0; i < count; i++) previous.add(addWallToStore(writer, anchor, params(i)).wallId);
    const read = vi.spyOn(MutablePropertyView.prototype, 'readNewEntity');
    const wall = S.addWall(M, level, params(count));
    expect(read.mock.calls.filter(([id]) => previous.has(id))).toHaveLength(0);
    expect(wall.notices).toBeUndefined();
    // A genuine move followed by another raw append must invalidate old endpoints.
    S.transformElements(M, [...previous].slice(-1), { kind: 'move', delta: [100, 0] });
    S.addEntity(M, { type: 'IfcCartesianPoint', attributes: [[-10, -10, 0]] });
    // Index maintenance must still discover the moved raw-created wall.
    S.addWall(M, level, { Start: [(count - 1) * 10 + 104, 0, 0], End: [(count - 1) * 10 + 104, 3, 0], Height: 3, Thickness: .2 });
    expect(session.bim.query().byType('IfcWall').toArray()).toHaveLength(count + 2);
    expect(session.bim.query().byType('IfcRelConnectsPathElements').toArray()).toHaveLength(1);
  } finally { session.close(); }
});

it('#9406 raw walls with forward geometry references are discovered after their records arrive', async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const session = await openModel(new TextEncoder().encode(creator.toIfc().content), { disableWorkerScan: true });
  try {
    const S = session.bim.store, M = session.bim.model.activeId()!;
    const anchor = resolveSpatialAnchor(session.store, level);
    const first = S.addEntity(M, { type: 'IfcCartesianPoint', attributes: [[-10, -10, 0]] }).expressId + 1;
    const ref = (offset: number) => `#${first + offset}`;
    // Product first, then its placement and swept rectangle. Each append is a
    // real public raw call; the wall is unreadable until later records arrive.
    const rows: Array<[string, unknown[]]> = [
      ['IfcWall', ['0AAAAAAAAAAAAAAAAAAAAA', null, 'Forward', null, null, ref(1), ref(5), null, '.NOTDEFINED.']],
      ['IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, ref(2)]],
      ['IfcAxis2Placement3D', [ref(3), null, ref(4)]],
      ['IfcCartesianPoint', [[0, 0, 0]]], ['IfcDirection', [[1, 0, 0]]],
      ['IfcProductDefinitionShape', [null, null, [ref(6)]]],
      ['IfcShapeRepresentation', [`#${anchor.bodyContextId}`, 'Body', 'SweptSolid', [ref(7)]]],
      ['IfcExtrudedAreaSolid', [ref(8), ref(2), ref(9), 3]],
      ['IfcRectangleProfileDef', ['.AREA.', null, ref(10), 4, .2]],
      ['IfcDirection', [[0, 0, 1]]], ['IfcAxis2Placement2D', [ref(11), null]],
      ['IfcCartesianPoint', [[2, 0]]],
      ['IfcRelContainedInSpatialStructure', ['1AAAAAAAAAAAAAAAAAAAAA', null, null, null, [ref(0)], `#${level}`]],
    ];
    rows.forEach(([type, attributes], i) => expect(S.addEntity(M, { type, attributes }).expressId).toBe(first + i));
    S.addWall(M, level, { Start: [4, 0, 0], End: [4, 3, 0], Height: 3, Thickness: .2 });
    expect(session.bim.query().byType('IfcRelConnectsPathElements').toArray()).toHaveLength(1);
  } finally { session.close(); }
});
