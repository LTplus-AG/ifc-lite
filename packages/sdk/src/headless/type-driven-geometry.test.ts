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
  return { bim, S: bim.store, storey, thickness, exported, undo, backend };
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
    // Its own layer set usage sizes the occurrence as soon as it is assigned.
    expect(thickness(walls[2])).toBeCloseTo(0.4, 6);

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

  it('a gate and a door of the same size get their own types', async () => {
    const { bim, S, storey } = await session();
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 });
    const door = S.addHostedDoor('m', wall.expressId, { Offset: 2, Width: 0.9, Height: 2.1, PredefinedType: 'DOOR' });
    const gate = S.addHostedDoor('m', wall.expressId, { Offset: 5, Width: 0.9, Height: 2.1, PredefinedType: 'GATE' });
    const typeOf = (ref: { expressId: number }) => bim.query().byType('IfcDoorType').toArray()
      .find((t) => bim.related(t.ref, 'IfcRelDefinesByType', 'forward').some((o) => o.ref.expressId === ref.expressId));
    expect(typeOf(door)?.name).toBe('Door 900 × 2100');
    expect(typeOf(gate)?.name).toBe('Gate 900 × 2100');
  });

  it('a custom door operation types the door as USERDEFINED with that description, as the door itself is', async () => {
    const { S, storey, exported } = await session();
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    S.addHostedDoor('m', wall.expressId, { Offset: 2, Width: 1, Height: 2.1, OperationType: 'Custom pivot' });
    expect(exported()).toMatch(/IFCDOORTYPE\('[^']+',[^,]*,'Door 1000 \\X2\\00D7\\X0\\ 2100 custom pivot',\$,\$,\$,\$,\$,\$,\.DOOR\.,\.USERDEFINED\.,\$,'Custom pivot'\);/);
  });

  it('explicit USERDEFINED doors and windows with different descriptions get their own types', async () => {
    const { S, storey, exported } = await session();
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [12, 0, 0], Thickness: 0.2, Height: 3 });
    S.addHostedDoor('m', wall.expressId, { Offset: 1.5, Width: 0.9, Height: 2.1, OperationType: 'USERDEFINED', UserDefinedOperationType: 'Pivot' });
    S.addHostedDoor('m', wall.expressId, { Offset: 3.5, Width: 0.9, Height: 2.1, OperationType: 'USERDEFINED', UserDefinedOperationType: 'Revolving' });
    S.addHostedWindow('m', wall.expressId, { Offset: 6, Sill: 0.9, Width: 1.2, Height: 1.4, PartitioningType: 'USERDEFINED', UserDefinedPartitioningType: 'Bay' });
    S.addHostedWindow('m', wall.expressId, { Offset: 9, Sill: 0.9, Width: 1.2, Height: 1.4, PartitioningType: 'USERDEFINED', UserDefinedPartitioningType: 'Oriel' });
    const text = exported();
    for (const description of ['Pivot', 'Revolving']) {
      expect(text.match(new RegExp(`IFCDOORTYPE\\([^;]*\\.USERDEFINED\\.,\\$,'${description}'\\);`, 'g'))).toHaveLength(1);
    }
    for (const description of ['Bay', 'Oriel']) {
      expect(text.match(new RegExp(`IFCWINDOWTYPE\\([^;]*\\.USERDEFINED\\.,\\$,'${description}'\\);`, 'g'))).toHaveLength(1);
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

  it('an array of copies writes each type relationship once per batch, as one undo step', async () => {
    const { S, storey, backend, undo } = await session();
    const type = S.addElementType('m', { Type: 'IfcWallType', Name: 'WT', PredefinedType: 'STANDARD' });
    const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    const rel = S.assignType('m', type.expressId, [wall.expressId]);
    const view = backend.getMutationView()!;
    const relWrites = () => view.getMutations().filter((m) => m.entityId === rel.expressId).length;
    const before = relWrites();
    const copies = S.copyElements('m', [wall.expressId], Array.from({ length: 25 }, (_, i) => ({ offset: [0, 2 * (i + 1), 0] as [number, number, number] })));
    // One write carrying all 26 objects, not 25 ever-longer rewrites.
    expect(relWrites() - before).toBe(1);
    const related = view.getPositionalMutationsForEntity(rel.expressId)?.get(4) as string[];
    expect(related).toEqual([wall, ...copies].map((r) => `#${r.expressId}`));
    expect(undo()).toBeGreaterThan(0);
    expect(relWrites()).toBe(before);
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
    S.addMaterial('m', { Name: 'Red herring', Color: '#ff0000' });
    const text = exported();
    // Follow Concrete's own chain to its colour, so another material's style cannot satisfy it.
    expect(materialColour(text, concrete.expressId)).toEqual(['0.6039', '0.6039', '0.6039']);
    expect(() => S.addMaterial('m', { Name: 'Bad', Color: 'grey' })).toThrow(/not a hex colour/);
  });

  it('writes a schema-valid IFC2X3 appearance (style assignment wrapper, one-attribute shading)', async () => {
    const creator = new IfcCreator({ Schema: 'IFC2X3', Timestamp: 0 });
    creator.addIfcBuildingStorey({ Name: 'L0', Elevation: 0 });
    const { S, exported } = await session(new TextEncoder().encode(creator.toIfc().content));
    const brick = S.addMaterial('m', { Name: 'Brick', Color: '#aa5533' });
    const text = exported();
    expect(materialColour(text, brick.expressId)).toEqual(['0.6667', '0.3333', '0.2000']);
    expect(text).toMatch(/IFCSURFACESTYLESHADING\(#\d+\);/);
    expect(text).toMatch(/IFCSTYLEDITEM\(\$,\(#(\d+)\),\$\);/);
    const assignment = text.match(/IFCSTYLEDITEM\(\$,\(#(\d+)\),\$\);/)?.[1];
    expect(text).toMatch(new RegExp(`#${assignment}=IFCPRESENTATIONSTYLEASSIGNMENT\\(`));
  });
});

/** The IfcColourRgb channels (4 decimals) a material's IfcMaterialDefinitionRepresentation resolves to. */
function materialColour(text: string, materialId: number): string[] | null {
  const record = (id: string | undefined) => (id ? text.match(new RegExp(`^#${id}=([A-Z0-9]+)\\((.*)\\);$`, 'm')) : null);
  const refs = (args: string) => [...args.matchAll(/#(\d+)/g)].map((m) => m[1]);
  const mdr = text.match(new RegExp(`^#\\d+=IFCMATERIALDEFINITIONREPRESENTATION\\(\\$,\\$,\\(#(\\d+)\\),#${materialId}\\);$`, 'm'));
  let next = record(mdr?.[1]);                       // IfcStyledRepresentation(ctx, 'Style', 'Material', (item))
  next = record(next ? refs(next[2])[1] : undefined); // IfcStyledItem($, (style), $)
  next = record(next ? refs(next[2])[0] : undefined); // IfcSurfaceStyle, or the IFC2X3 IfcPresentationStyleAssignment
  if (next?.[1] === 'IFCPRESENTATIONSTYLEASSIGNMENT') next = record(refs(next[2])[0]);
  next = record(next ? refs(next[2])[0] : undefined); // IfcSurfaceStyleShading / Rendering
  next = record(next ? refs(next[2])[0] : undefined); // IfcColourRgb($, r, g, b)
  return next?.[1] === 'IFCCOLOURRGB' ? next[2].split(',').slice(1).map((v) => Number(v).toFixed(4)) : null;
}
