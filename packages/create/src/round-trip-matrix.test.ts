/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BUILD -> SERIALISE -> PARSE ROUND TRIP.
 *
 * `IfcCreator` is a promise: whatever the builder API accepts must come back
 * out the same when the emitted STEP text is parsed with `@ifc-lite/parser`.
 * `ifc-creator.test.ts` and `placement-datum.test.ts` already check the
 * *emitted STEP text* (string contains) and the *placement chain* (hand-walked
 * STEP); this file is the missing half — it round-trips through the real
 * parser and reads values back through the same accessors a consumer (the
 * viewer, the CLI, the SDK) would use: `getEntity`, `getProperties`,
 * `getQuantities`, and the on-demand material map.
 *
 * `toIfc()` on `IfcCreator` is its own STEP writer (unlike the in-store
 * builders under `in-store/`, which emit into an overlay that
 * `@ifc-lite/export`'s `MergedExporter` serialises) — so for this API,
 * `toIfc().content` already IS "serialised with the writer".
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { IfcCreator } from './ifc-creator.js';
import type { PropertyDef } from './types.js';

async function parseStep(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
}

describe('IfcCreator build -> serialise -> parse round trip', () => {
  it('round-trips a matrix model field-by-field, GlobalId-matched', async () => {
    const c = new IfcCreator({
      Name: 'Матрица проекта', // Cyrillic — non-ASCII must survive untouched (#3556 territory)
      Description: 'round-trip matrix fixture',
      Organization: 'ifc-lite tests',
      LengthUnit: 'MILLIMETRE',
    });
    const storey = c.addIfcBuildingStorey({ Name: 'Этаж 1', Elevation: -1.5, Description: 'basement' });

    // Names: unicode, empty string (distinct from omitted -> default), and
    // omitted (falls back to the constructor's documented default).
    const wallUnicode = c.addIfcWall(storey, {
      Start: [0, 0, 0], End: [0, 5000, 0], Thickness: 200, Height: 3000, Name: 'Стена №1',
    });
    const wallEmpty = c.addIfcWall(storey, {
      Start: [0, 0, 0], End: [3000, 0, 0], Thickness: 200, Height: 3000, Name: '',
    });
    const wallDefault = c.addIfcWall(storey, {
      Start: [0, 1000, 0], End: [3000, 1000, 0], Thickness: 200, Height: 3000,
    });

    // Rotated placements: 90 degrees (End along +Y) and an arbitrary angle
    // (3-4-5 triangle -> direction ratios [0.6, 0.8, 0]), asserted numerically
    // below rather than trusted from the inputs.
    const wall90 = c.addIfcWall(storey, {
      Start: [0, 2000, 0], End: [0, 7000, 0], Thickness: 200, Height: 3000, Name: 'w90',
    });
    const wallArb = c.addIfcWall(storey, {
      Start: [1000, 1000, 0], End: [4000, 5000, 0], Thickness: 200, Height: 3000, Name: 'wArb',
    });

    // Every NominalValue type the builder documents, plus explicit Type
    // overrides for the string family (IfcLabel/IfcText/IfcIdentifier).
    const psetProps: PropertyDef[] = [
      { Name: 'BoolProp', NominalValue: true },
      { Name: 'IntProp', NominalValue: 42 },
      { Name: 'RealProp', NominalValue: 3.14 },
      { Name: 'StrProp', NominalValue: 'hello' },
      { Name: 'LabelProp', NominalValue: 'lbl', Type: 'IfcLabel' },
      { Name: 'TextProp', NominalValue: 'txt', Type: 'IfcText' },
      { Name: 'IdProp', NominalValue: 'id1', Type: 'IfcIdentifier' },
      { Name: 'LogicalProp', NominalValue: false, Type: 'IfcLogical' },
    ];
    c.addIfcPropertySet(wallUnicode, { Name: 'Pset_Custom', Properties: psetProps });
    // Two psets with the SAME name on the same element (#3539/#3541
    // semantics): both must survive as distinct sets, not merge or overwrite.
    c.addIfcPropertySet(wallUnicode, {
      Name: 'Pset_Custom',
      Properties: [{ Name: 'Other', NominalValue: 'second set' }],
    });

    // Every QuantityKind the builder documents.
    c.addIfcElementQuantity(wallUnicode, {
      Name: 'Qto_Test',
      Quantities: [
        { Name: 'Len', Value: 5000, Kind: 'IfcQuantityLength' },
        { Name: 'Area', Value: 10, Kind: 'IfcQuantityArea' },
        { Name: 'Vol', Value: 20, Kind: 'IfcQuantityVolume' },
        { Name: 'Cnt', Value: 3, Kind: 'IfcQuantityCount' },
        { Name: 'Wt', Value: 100, Kind: 'IfcQuantityWeight' },
      ],
    });

    // Layered material.
    c.addIfcMaterial(wallUnicode, {
      Name: 'Wall Assembly',
      Layers: [
        { Name: 'Outer', Thickness: 100, Category: 'Structural' },
        { Name: 'Insulation', Thickness: 50, IsVentilated: true },
      ],
    });

    const { content } = c.toIfc();
    const store = await parseStep(content);

    // --- Names: unicode, empty string, and default all come back exactly. ---
    expect(store.getEntity(wallUnicode)!.attributes[2]).toBe('Стена №1');
    expect(store.getEntity(wallEmpty)!.attributes[2]).toBe('');
    expect(store.getEntity(wallDefault)!.attributes[2]).toBe('Wall');

    // --- Project/storey names (unicode) and elevation. ---
    const project = store.getEntitiesByType('IFCPROJECT')[0]!;
    expect(project.attributes[2]).toBe('Матрица проекта');
    const storeyEntity = store.getEntity(storey)!;
    expect(storeyEntity.attributes[2]).toBe('Этаж 1');
    expect(storeyEntity.attributes[9]).toBeCloseTo(-1.5, 9);

    // --- Rotated placements: direction ratios of the wall's local X axis. ---
    function refDirectionOf(elementId: number): number[] {
      const placementId = store.getEntity(elementId)!.attributes[5] as number;
      const axis2Id = store.getEntity(placementId)!.attributes[1] as number;
      const refDirId = store.getEntity(axis2Id)!.attributes[2] as number;
      return store.getEntity(refDirId)!.attributes[0] as number[];
    }
    const dir90 = refDirectionOf(wall90);
    expect(dir90[0]).toBeCloseTo(0, 9);
    expect(dir90[1]).toBeCloseTo(1, 9);
    expect(dir90[2]).toBeCloseTo(0, 9);
    const dirArb = refDirectionOf(wallArb);
    expect(dirArb[0]).toBeCloseTo(0.6, 9);
    expect(dirArb[1]).toBeCloseTo(0.8, 9);
    expect(dirArb[2]).toBeCloseTo(0, 9);

    // --- Property sets: values AND types, both same-named sets present. ---
    const psets = store.getProperties(wallUnicode);
    expect(psets.map((p) => p.name).sort()).toEqual(['Pset_Custom', 'Pset_Custom']);
    const [main, second] = psets[0]!.properties.length >= psets[1]!.properties.length
      ? [psets[0]!, psets[1]!]
      : [psets[1]!, psets[0]!];
    const byName = new Map(main.properties.map((p) => [p.name, p]));
    expect(byName.get('BoolProp')!.value).toBe(true);
    expect(byName.get('IntProp')!.value).toBe(42);
    expect(byName.get('RealProp')!.value).toBeCloseTo(3.14, 9);
    expect(byName.get('StrProp')!.value).toBe('hello');
    expect(byName.get('LabelProp')!.dataType).toBe('IFCLABEL');
    expect(byName.get('TextProp')!.dataType).toBe('IFCTEXT');
    expect(byName.get('IdProp')!.dataType).toBe('IFCIDENTIFIER');
    // The fix under test: Type: 'IfcLogical' must come back declared as
    // IFCLOGICAL, not silently downgraded to IFCBOOLEAN.
    expect(byName.get('LogicalProp')!.dataType).toBe('IFCLOGICAL');
    expect(byName.get('LogicalProp')!.value).toBe(false);
    expect(second.properties.map((p) => p.name)).toEqual(['Other']);
    expect(second.properties[0]!.value).toBe('second set');

    // --- Quantities: every kind, value AND kind. ---
    const qsets = store.getQuantities(wallUnicode);
    expect(qsets).toHaveLength(1);
    const qtyByName = new Map(qsets[0]!.quantities.map((q) => [q.name, q]));
    expect(qtyByName.get('Len')!.value).toBeCloseTo(5000, 9);
    expect(qtyByName.get('Area')!.value).toBeCloseTo(10, 9);
    expect(qtyByName.get('Vol')!.value).toBeCloseTo(20, 9);
    expect(qtyByName.get('Cnt')!.value).toBeCloseTo(3, 9);
    expect(qtyByName.get('Wt')!.value).toBeCloseTo(100, 9);

    // --- Material: layered set, layer names/thicknesses, IsVentilated. ---
    const materialIds = store.onDemandMaterialMap?.get(wallUnicode) ?? [];
    expect(materialIds).toHaveLength(1);
    const layerSet = store.getEntity(materialIds[0]!)!;
    expect(layerSet.type).toBe('IFCMATERIALLAYERSET');
    expect(layerSet.attributes[1]).toBe('Wall Assembly');
    const layerRefs = layerSet.attributes[0] as number[];
    expect(layerRefs).toHaveLength(2);
    const layers = layerRefs.map((id) => store.getEntity(id)!);
    expect(layers.map((l) => l.attributes[3])).toEqual(['Outer', 'Insulation']);
    expect(layers[0]!.attributes[1]).toBeCloseTo(100, 9);
    expect(layers[1]!.attributes[1]).toBeCloseTo(50, 9);
    expect(layers[1]!.attributes[2]).toBe('.T.'); // IsVentilated (raw STEP boolean enum token)

    // --- Spatial containment: every wall lands under the one storey. ---
    const containedRels = store.getEntitiesByType('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    const containedIn = new Map<number, number>();
    for (const rel of containedRels) {
      const relatedIds = rel.attributes[4] as number[];
      const container = rel.attributes[5] as number;
      for (const id of relatedIds) containedIn.set(id, container);
    }
    for (const wallId of [wallUnicode, wallEmpty, wallDefault, wall90, wallArb]) {
      expect(containedIn.get(wallId)).toBe(storey);
    }

    // --- Units: the requested MILLIMETRE unit is the one actually referenced
    // by IFCUNITASSIGNMENT (not an orphaned METRE alongside it). ---
    const unitAssignment = store.getEntitiesByType('IFCUNITASSIGNMENT')[0]!;
    const unitRefs = unitAssignment.attributes[0] as number[];
    const lengthUnit = store.getEntity(unitRefs[0]!)!;
    expect(lengthUnit.type).toBe('IFCSIUNIT');
    expect(lengthUnit.attributes[2]).toBe('.MILLI.');
  });

  it('emits IFCLOGICAL for a boolean property with Type: "IfcLogical" (not IFCBOOLEAN)', () => {
    // RED on unmodified main: the writer hardcoded IFCBOOLEAN for every
    // boolean NominalValue and ignored `Type` entirely, so this line read
    // `IFCPROPERTYSINGLEVALUE('P',$,IFCBOOLEAN(.T.),$);` — actual IFCBOOLEAN,
    // expected IFCLOGICAL. `Type` is a public, documented `PropertyDef` field
    // ('IfcLogical' is one of the seven `PropertyType` values); silently
    // downgrading it is exactly the "builder-accepted input silently dropped
    // by the writer" class of defect.
    const c = new IfcCreator();
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = c.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    c.addIfcPropertySet(wallId, {
      Name: 'PsetLogical',
      Properties: [{ Name: 'LogProp', NominalValue: true, Type: 'IfcLogical' }],
    });

    const { content } = c.toIfc();
    expect(content).toContain('IFCLOGICAL(.T.)');
    expect(content).not.toContain('IFCBOOLEAN(.T.)');
  });

  it('control: a boolean without Type, or with Type: "IfcBoolean", still emits IFCBOOLEAN', () => {
    const c = new IfcCreator();
    const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = c.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    c.addIfcPropertySet(wallId, {
      Name: 'PsetBoolean',
      Properties: [
        { Name: 'Default', NominalValue: true },
        { Name: 'Explicit', NominalValue: false, Type: 'IfcBoolean' },
      ],
    });

    const { content } = c.toIfc();
    expect(content).toContain('IFCBOOLEAN(.T.)');
    expect(content).toContain('IFCBOOLEAN(.F.)');
    expect(content).not.toContain('IFCLOGICAL');
  });
});
