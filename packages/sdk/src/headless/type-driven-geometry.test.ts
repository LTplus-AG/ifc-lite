/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types drive geometry (#9296 lane C2): a layered type's total thickness sizes
 * the walls it types, on assignment, on retyping and when the type is
 * re-layered, in one undo step; placed doors and windows are typed
 * occurrences; a material carries its own appearance.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcCreator, readWallJoinTarget } from '@ifc-lite/create';
import { parseModel } from '@ifc-lite/parser';
import { undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { createBimContext } from '../index.js';
import { HeadlessBackend } from './backend.js';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

async function session(bytes: Uint8Array = readFileSync(sample)) {
  const { store } = await parseModel(bytes, { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'model.ifc', 'm');
  const bim = createBimContext({ backend });
  const storey = bim.query().byType('IfcBuildingStorey').toArray()[0].ref.expressId;
  const thickness = (ref: { expressId: number }) =>
    readWallJoinTarget(store, backend.getMutationView(), ref.expressId, store.lengthUnitScale ?? 1)?.wall.thickness;
  const exported = () => {
    const out = bim.export.ifc();
    return typeof out === 'string' ? out : new TextDecoder().decode(out);
  };
  // MCP's mutation_undo path, one operation: it reverts one compound record (whose writes it counts);
  // reaching a raw revert would mean the store call split into separate undo steps.
  const undo = () => undoRecordedMutationOperations(backend.getMutationView()!, 1, () => { throw new Error('not one compound record'); });
  return { bim, S: bim.store, storey, thickness, exported, undo };
}

type Store = Awaited<ReturnType<typeof session>>['S'];
function layeredType(S: Store, name: string, layers: Array<[string, number]>) {
  const type = S.addElementType('m', { Type: 'IfcWallType', Name: name, PredefinedType: 'STANDARD' });
  const set = S.addMaterialLayerSet('m', {
    LayerSetName: name,
    MaterialLayers: layers.map(([Name, LayerThickness]) => ({ Material: S.addMaterial('m', { Name }).expressId, LayerThickness })),
  });
  S.assignMaterial('m', set.expressId, [type.expressId]);
  return { type, set };
}

describe('a layered type drives the thickness of what it types', () => {
  it('typing and retyping resize the wall body, each as one undo step', async () => {
    const { bim, S, storey, thickness, undo } = await session();
    const ext = layeredType(S, 'Ext 230', [['Brick', 0.115], ['Mineral wool', 0.1], ['Gypsum plaster', 0.015]]);
    const wt300 = layeredType(S, 'WT-300', [['Concrete', 0.3]]);
    const wall = S.addWall('m', storey, { Start: [0, 3, 0], End: [5, 3, 0], Thickness: 0.1, Height: 3 });
    expect(thickness(wall)).toBeCloseTo(0.1, 6);

    S.assignType('m', ext.type.expressId, [wall.expressId]);
    expect(thickness(wall)).toBeCloseTo(0.23, 6);
    S.assignType('m', wt300.type.expressId, [wall.expressId]);
    expect(thickness(wall)).toBeCloseTo(0.3, 6);

    // One undo takes back the retype and its resize together.
    expect(undo()).toBeGreaterThan(0);
    expect(thickness(wall)).toBeCloseTo(0.23, 6);
    expect(bim.related(wall, 'IfcRelDefinesByType', 'inverse').map((t) => t.ref.expressId)).toEqual([ext.type.expressId]);
    expect(undo()).toBeGreaterThan(0);
    expect(thickness(wall)).toBeCloseTo(0.1, 6);
  });

  it('re-layering a type resizes every occurrence; an occurrence with its own layer set follows its own', async () => {
    const { S, storey, thickness } = await session();
    const { type } = layeredType(S, 'WT', [['Brick', 0.2]]);
    const walls = [0, 2, 4].map((y) => S.addWall('m', storey, { Start: [0, y, 0], End: [5, y, 0], Thickness: 0.2, Height: 3 }));
    S.assignType('m', type.expressId, walls.map((w) => w.expressId));
    const own = S.addMaterialLayerSet('m', { LayerSetName: 'Own', MaterialLayers: [{ Material: S.addMaterial('m', { Name: 'Stone' }).expressId, LayerThickness: 0.4 }] });
    S.assignMaterial('m', S.addMaterialLayerSetUsage('m', { ForLayerSet: own.expressId, OffsetFromReferenceLine: -0.2 }).expressId, [walls[2].expressId]);

    const thicker = S.addMaterialLayerSet('m', { LayerSetName: 'WT 250', MaterialLayers: [{ Material: S.addMaterial('m', { Name: 'Block' }).expressId, LayerThickness: 0.25 }] });
    S.assignMaterial('m', thicker.expressId, [type.expressId]);
    expect(walls.map((w) => Number(thickness(w)?.toFixed(6)))).toEqual([0.25, 0.25, 0.4]);
  });

  it('reads layer thickness in metres in a millimetre model', async () => {
    const creator = new IfcCreator({ Schema: 'IFC4', LengthUnit: 'MILLIMETRE', Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'L0', Elevation: 0 });
    const { S, storey, thickness } = await session(new TextEncoder().encode(creator.toIfc().content));
    const { type } = layeredType(S, 'Ext 230', [['Brick', 0.115], ['Mineral wool', 0.1], ['Gypsum plaster', 0.015]]);
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.1, Height: 3 });
    S.assignType('m', type.expressId, [wall.expressId]);
    expect(thickness(wall)).toBeCloseTo(0.23, 6);
  });
});

describe('placed doors and windows are typed occurrences', () => {
  it('reuses one type per size and operation, and an explicit type replaces it', async () => {
    const { bim, S, storey, exported } = await session();
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 });
    const d1 = S.addHostedDoor('m', wall.expressId, { Offset: 1.5, Width: 0.9, Height: 2.1 });
    const d2 = S.addHostedDoor('m', wall.expressId, { Offset: 3, Width: 0.9, Height: 2.1 });
    const w1 = S.addHostedWindow('m', wall.expressId, { Offset: 5.5, Sill: 0.9, Width: 1.2, Height: 1.4 });
    const typeOf = (ref: { expressId: number }) => bim.query().byType('IfcDoorType', 'IfcWindowType').toArray()
      .find((t) => bim.related(t.ref, 'IfcRelDefinesByType', 'forward').some((o) => o.ref.expressId === ref.expressId));
    expect(typeOf(d1)?.name).toBe('Door 900 × 2100');
    expect(typeOf(d2)?.ref.expressId).toBe(typeOf(d1)?.ref.expressId);
    expect(typeOf(w1)?.name).toBe('Window 1200 × 1400');

    const own = S.addElementType('m', { Type: 'IfcDoorType', Name: 'D 90x210', PredefinedType: 'DOOR', OperationType: 'SINGLE_SWING_LEFT' });
    S.assignType('m', own.expressId, [d2.expressId]);
    expect(typeOf(d2)?.ref.expressId).toBe(own.expressId);
    const text = exported();
    expect(text.match(/IFCDOORTYPE\(/g)).toHaveLength(2);
    // One IfcRelDefinesByType per type (IFC allows a type no more): auto door type {d1}, window type {w1}, own {d2}.
    for (const [type, objects] of [[typeOf(d1)!.ref.expressId, [d1]], [typeOf(w1)!.ref.expressId, [w1]], [own.expressId, [d2]]] as const) {
      const rels = text.match(new RegExp(`IFCRELDEFINESBYTYPE\\([^;]*,#${type}\\);`, 'g')) ?? [];
      expect(rels).toHaveLength(1);
      expect(rels[0]).toContain(`(${objects.map((o) => `#${o.expressId}`).join(',')})`);
    }
  });

  it('copying a typed element extends its type relationship rather than adding one', async () => {
    const { S, storey, exported } = await session();
    const type = S.addElementType('m', { Type: 'IfcWallType', Name: 'WT', PredefinedType: 'STANDARD' });
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    S.assignType('m', type.expressId, [wall.expressId]);
    const copies = S.copyElements('m', [wall.expressId], [{ offset: [0, 2, 0] }, { offset: [0, 4, 0] }]);
    const rels = exported().match(new RegExp(`IFCRELDEFINESBYTYPE\\([^;]*,#${type.expressId}\\);`, 'g')) ?? [];
    expect(rels).toHaveLength(1);
    for (const id of [wall.expressId, ...copies.map((c) => c.expressId)]) expect(rels[0]).toMatch(new RegExp(`#${id}\\b`));
  });

  it('IFC2X3 has no door type, so the door stays untyped', async () => {
    const creator = new IfcCreator({ Schema: 'IFC2X3', Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'L0', Elevation: 0 });
    const { S, storey, exported } = await session(new TextEncoder().encode(creator.toIfc().content));
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    S.addHostedDoor('m', wall.expressId, { Offset: 2, Width: 0.9, Height: 2.1 });
    expect(exported()).not.toMatch(/IFCDOORTYPE|IFCDOORSTYLE|IFCRELDEFINESBYTYPE/);
  });
});

describe('a material carries its appearance', () => {
  it('writes IfcMaterialDefinitionRepresentation with the colour on the material', async () => {
    const { S, exported } = await session();
    const concrete = S.addMaterial('m', { Name: 'Concrete C30/37', Category: 'concrete', Color: '#9a9a9a' });
    const text = exported();
    const rep = text.match(/IFCMATERIALDEFINITIONREPRESENTATION\(\$,\$,\(#(\d+)\),#(\d+)\);/);
    expect(Number(rep?.[2])).toBe(concrete.expressId);
    expect(text).toMatch(new RegExp(`#${rep?.[1]}=IFCSTYLEDREPRESENTATION\\(#\\d+,'Style','Material',\\(#\\d+\\)\\);`));
    expect(text).toMatch(/IFCCOLOURRGB\(\$,0\.6039\d*,0\.6039\d*,0\.6039\d*\)/);
    expect(() => S.addMaterial('m', { Name: 'Bad', Color: 'grey' })).toThrow(/not a hex colour/);
  });
});
