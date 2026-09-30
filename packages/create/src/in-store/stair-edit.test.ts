/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcCreator } from '../ifc-creator.js';
import { addStairToStore } from './stair.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { editStairDimensionsInStore, readStairDimensions } from './stair-edit.js';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from './stair-mesh.oracle.js';

async function fixture(Schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', millimetres = false) {
  const c = new IfcCreator({ Schema, LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE' });
  const storey = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  let store = await parse(c.toIfc().content);
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const built = addStairToStore(editor, resolveSpatialAnchor(store, storey, view), {
    Position: [1, 2, 0], Direction: Math.PI / 2, NumberOfRisers: 10,
    RiserHeight: 0.2, TreadLength: 0.3, Width: 1.2, WaistThickness: 0.15,
  });
  const other = addStairToStore(editor, resolveSpatialAnchor(store, storey, view), {
    Position: [10, 2, 0], Direction: Math.PI / 2, NumberOfRisers: 10,
    RiserHeight: 0.2, TreadLength: 0.3, Width: 1.2, WaistThickness: 0.15,
  });
  editor.setPositionalAttribute(other.flightId, 6, `#${built.productShapeId}`);
  const colour = editor.addEntity('IfcColourRgb', [null, 0.2, 0.4, 0.6]).expressId;
  const rendering = editor.addEntity('IfcSurfaceStyleRendering', [`#${colour}`, 0, null, null, null, null, null, null, '.NOTDEFINED.']).expressId;
  const surface = editor.addEntity('IfcSurfaceStyle', ['Shared stair style', '.BOTH.', [`#${rendering}`]]).expressId;
  const style = Schema === 'IFC2X3' ? editor.addEntity('IfcPresentationStyleAssignment', [[`#${surface}`]]).expressId : surface;
  editor.addEntity('IfcStyledItem', [`#${built.solidId}`, [`#${style}`], null]);
  // Read the actual STEP source, not just the builder's in-memory values.
  const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: Schema, applyMutations: true }).content);
  store = await parse(text); view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  return { store, view, editor, built, other, reader: new AnchorEntityReader(store, view) };
}

describe('strict canonical stair edits (#6232)', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const mm of [false, true]) {
    it(`${schema} ${mm ? 'millimetres' : 'metres'} parent/flight edits preserve the source body and placements`, async () => {
      const { store, view, editor, built, reader } = await fixture(schema, mm);
      const before = readStairDimensions(store, built.flightId, view);
      expect(before).not.toBeNull();
      expect(before!.Width).toBeCloseTo(1.2, 8);
      expect(before!.WaistThickness).toBeCloseTo(0.15, 8);
      expect(readStairDimensions(store, built.stairId, view)).toEqual(before);
      const source = [built.profileId, built.solidId, built.productShapeId, built.placementId, built.flightPlacementId]
        .map(id => reader.entity(id));
      const next = editStairDimensionsInStore(store, editor, built.stairId, { Width: 1.4, RiserHeight: 0.22, TreadLength: 0.35 });
      expect(next.Width).toBeCloseTo(1.4, 8);
      expect(next.RiserHeight * next.NumberOfRisers).toBeCloseTo(2.2, 8);
      expect(next.TreadLength * next.NumberOfRisers).toBeCloseTo(3.5, 8);
      expect(next.WaistThickness).toBeCloseTo(0.15, 8);
      expect([built.profileId, built.solidId, built.productShapeId, built.placementId, built.flightPlacementId]
        .map(id => reader.entity(id))).toEqual(source);
    });
  }

  it('refuses a second aggregate flight, invalid dimensions and a changed stepped outline without writes', async () => {
    const { store, view, editor, built, reader } = await fixture('IFC4');
    const unchanged = () => ({ records: view.getMutations(), entities: view.getNewEntities() });
    for (const patch of [{ Width: 0 }, { RiserHeight: NaN }, { TreadLength: -1 }, { WaistThickness: 3 }]) {
      const before = unchanged();
      expect(() => editStairDimensionsInStore(store, editor, built.flightId, patch)).toThrow();
      expect(unchanged()).toEqual(before);
    }
    editor.setPositionalAttribute(built.relAggregatesId, 5, [`#${built.flightId}`, `#${built.flightId}`]);
    const before = unchanged();
    expect(() => editStairDimensionsInStore(store, editor, built.stairId, { Width: 1.4 })).toThrow(/supported/);
    expect(unchanged()).toEqual(before);
    // Restore relationship, then change a real polygon point to a sloped tread.
    editor.setPositionalAttribute(built.relAggregatesId, 5, [`#${built.flightId}`]);
    const curveId = reader.entity(built.profileId)!.attributes[2] as number;
    const pointId = (reader.entity(curveId)!.attributes[0] as number[])[3];
    editor.setPositionalAttribute(pointId, 0, [200, 200]);
    const altered = unchanged();
    expect(readStairDimensions(store, built.flightId, view)).toBeNull();
    expect(() => editStairDimensionsInStore(store, editor, built.flightId, { Width: 1.4 })).toThrow(/supported/);
    expect(unchanged()).toEqual(altered);
  });

  for (const mm of [false, true]) it.skipIf(!stairWasmAvailable)(`real ${mm ? 'millimetre' : 'metre'} WASM retains a shared source body/style and changes only the selected flight`, async () => {
    const { store, view, editor, built, other } = await fixture('IFC4', mm);
    const exportModel = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const before = await meshStairs(exportModel());
    expect(before.get(built.flightId)?.length).toBeGreaterThan(0);
    expect(before.get(other.flightId)?.length).toBeGreaterThan(0);
    const original = stairMeshBounds(before.get(built.flightId)!);
    expect(original.min[0]).toBeCloseTo(-0.2, 5);
    expect(original.max[2]).toBeCloseTo(2, 5);
    editStairDimensionsInStore(store, editor, built.flightId, { Width: 1.4, RiserHeight: 0.22, TreadLength: 0.35 });
    const after = await meshStairs(exportModel());
    const box = stairMeshBounds(after.get(built.flightId)!);
    expect(box.min[0]).toBeCloseTo(-0.4, 5);
    expect(box.max[0]).toBeCloseTo(original.max[0], 5);
    expect(box.min[1]).toBeCloseTo(original.min[1], 5);
    expect(box.max[1]).toBeCloseTo(5.5, 5);
    expect(box.min[2]).toBeCloseTo(original.min[2], 5);
    expect(box.max[2]).toBeCloseTo(2.2, 5);
    expect(after.get(other.flightId)).toEqual(before.get(other.flightId));
    expect(after.get(built.flightId)![0].color).toEqual(before.get(built.flightId)![0].color);
  });

  it('rolls back a late unreadable style attachment after emitting the replacement body (#6232)', async () => {
    const { store, view, editor, built, reader } = await fixture('IFC4');
    const styleId = [...reader.ids('IFCSTYLEDITEM')][0];
    editor.setPositionalAttribute(styleId, 1, []);
    const records = view.getMutations(), entities = view.getNewEntities();
    expect(() => editStairDimensionsInStore(store, editor, built.flightId, { Width: 1.4 })).toThrow(/style attachment/);
    expect(view.getMutations()).toEqual(records);
    expect(view.getNewEntities()).toEqual(entities);
    expect(readStairDimensions(store, built.flightId, view)?.Width).toBeCloseTo(1.2, 8);
  });

  it('treats explicit undefined fields as omitted, preserving the geometric waist (#6232)', async () => {
    const { store, editor, built } = await fixture('IFC4');
    const next = editStairDimensionsInStore(store, editor, built.flightId, { Width: 1.4, WaistThickness: undefined });
    expect(next.Width).toBeCloseTo(1.4, 8);
    expect(next.WaistThickness).toBeCloseTo(0.15, 8);
    expect(next.NumberOfRisers).toBe(10);
  });
});
