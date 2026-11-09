/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live session reads back what it authored (#9296 lane C2). Materials,
 * layer sets, IfcRelDefinesByType and type property sets added in the mutation
 * overlay must answer through `bim.materials()` / `bim.typeProperties()` before
 * export, exactly as they do after export and reopen.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openModel } from '../headless.js';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

async function session() {
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  const storey = model.bim.query().byType('IfcBuildingStorey').toArray()[0].ref.expressId;
  return { model, bim: model.bim, S: model.bim.store, storey };
}

describe('live session readback of authored relationships', () => {
  it('bim.materials() reads an authored material and a layer set usage before export', async () => {
    const { model, bim, S, storey } = await session();
    try {
      const concrete = S.addMaterial('m', { Name: 'Concrete C30/37', Category: 'concrete' });
      const slab = S.addSlab('m', storey, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.25, Name: 'Slab' });
      S.assignMaterial('m', concrete.expressId, [slab.expressId]);
      expect(bim.materials(slab)).toMatchObject({ type: 'Material', name: 'Concrete C30/37', category: 'concrete' });

      const names = ['Brick', 'Mineral wool', 'Gypsum plaster'];
      const mats = names.map((Name) => S.addMaterial('m', { Name }).expressId);
      const set = S.addMaterialLayerSet('m', { LayerSetName: 'Ext 230', MaterialLayers: [
        { Material: mats[0], LayerThickness: 0.115 }, { Material: mats[1], LayerThickness: 0.1 }, { Material: mats[2], LayerThickness: 0.015 },
      ] });
      const usage = S.addMaterialLayerSetUsage('m', { ForLayerSet: set.expressId, OffsetFromReferenceLine: -0.115 });
      const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.23, Height: 3, Name: 'Layered' });
      S.assignMaterial('m', usage.expressId, [wall.expressId]);
      const layered = bim.materials(wall);
      expect(layered?.type).toBe('MaterialLayerSet');
      expect(layered?.layers?.map((l) => l.materialName)).toEqual(names);

      // Reassignment replaces, also in the session.
      const steel = S.addMaterial('m', { Name: 'Steel S355' });
      S.assignMaterial('m', steel.expressId, [slab.expressId]);
      expect(bim.materials(slab)?.name).toBe('Steel S355');
    } finally { model.close(); }
  });

  it('bim.materials() falls back to the material of the authored type', async () => {
    const { model, bim, S, storey } = await session();
    try {
      const type = S.addElementType('m', { Type: 'IfcWallType', Name: 'WT', PredefinedType: 'STANDARD' });
      const brick = S.addMaterial('m', { Name: 'Brick' });
      S.assignMaterial('m', brick.expressId, [type.expressId]);
      const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
      S.assignType('m', type.expressId, [wall.expressId]);
      expect(bim.materials(wall)?.name).toBe('Brick');
    } finally { model.close(); }
  });

  it('bim.typeProperties() reads authored type psets on every occurrence, follows edits and retyping', async () => {
    const { model, bim, S, storey } = await session();
    try {
      const A = S.addElementType('m', { Type: 'IfcWallType', Name: 'WT-200', PredefinedType: 'STANDARD' });
      const B = S.addElementType('m', { Type: 'IfcWallType', Name: 'WT-300', PredefinedType: 'STANDARD' });
      const walls = [0, 2, 4].map((y) => S.addWall('m', storey, { Start: [0, y, 0], End: [5, y, 0], Thickness: 0.2, Height: 3 }));
      S.assignType('m', A.expressId, walls.map((w) => w.expressId));
      bim.mutate.setProperty(A, 'Pset_WallCommon', 'FireRating', 'EI60', 'IfcLabel');
      const rating = (w: typeof walls[number]) => bim.typeProperties(w)?.properties
        .find((p) => p.name === 'Pset_WallCommon')?.properties.find((p) => p.name === 'FireRating')?.value ?? null;
      for (const w of walls) {
        expect(bim.typeProperties(w)).toMatchObject({ typeName: 'WT-200', typeId: A.expressId });
        expect(rating(w)).toBe('EI60');
      }
      bim.mutate.setProperty(A, 'Pset_WallCommon', 'FireRating', 'EI90', 'IfcLabel');
      expect(walls.map(rating)).toEqual(['EI90', 'EI90', 'EI90']);

      bim.mutate.setProperty(B, 'Pset_WallCommon', 'FireRating', 'EI120', 'IfcLabel');
      S.assignType('m', B.expressId, [walls[2].expressId]);
      expect(bim.typeProperties(walls[2])).toMatchObject({ typeName: 'WT-300', typeId: B.expressId });
      expect(walls.map(rating)).toEqual(['EI90', 'EI90', 'EI120']);
    } finally { model.close(); }
  });

  it('bim.classifications() reads a classification associated in the session', async () => {
    const { model, bim, S, storey } = await session();
    try {
      const wall = S.addWall('m', storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
      expect(bim.classifications(wall)).toEqual([]);
      const reference = S.addEntity('m', { type: 'IfcClassificationReference', attributes: [null, '21.22', 'External walls', null, null, null] });
      S.addEntity('m', { type: 'IfcRelAssociatesClassification', attributes: ['2b1Jp0NnD0DwV7a3Vf6Nq1', null, null, null, [`#${wall.expressId}`], `#${reference.expressId}`] });
      expect(bim.classifications(wall)).toEqual([expect.objectContaining({ identification: '21.22', name: 'External walls' })]);
    } finally { model.close(); }
  });

  it('answers the parsed model the same before and after the session starts editing', async () => {
    const { model, bim, S, storey } = await session();
    try {
      const wall = bim.query().byType('IfcWall').toArray()[0].ref;
      const parsed = { type: 'MaterialLayerSet', layers: [{ materialName: 'CONCRETE', thickness: 0.1 }] };
      // Read-only: the store path.
      expect(bim.materials(wall)).toEqual(parsed);
      expect(bim.typeProperties(wall)).toBeNull();
      // An unrelated edit routes every read through the live view; the parsed wall must not change.
      S.addWall('m', storey, { Start: [0, 5, 0], End: [5, 5, 0], Thickness: 0.2, Height: 3 });
      expect(bim.materials(wall)).toEqual(parsed);
      expect(bim.typeProperties(wall)).toBeNull();
    } finally { model.close(); }
  });
});
