/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, recordCompoundMutation, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { addRoofToStore } from './roof.js';
import { editFootprintRoofInStore } from './roof-footprint.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';
import { copyBatchInStore } from './copy-batch.js';
import { exportText, newStorey, parse } from './wall-join-mesh.oracle.js';

const D = Math.PI / 180;
const HIP = { Position: [0, 0, 3] as [number, number, number], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(30 * D) };

type Session = Awaited<ReturnType<typeof newStorey>>;
function parts(s: Pick<Session, 'store' | 'view'>, roof: number): number[] {
  const r = new AnchorEntityReader(s.store, s.view);
  const result: number[] = [];
  for (const type of ['IFCRELAGGREGATES', 'IFCRELASSIGNSTOPRODUCT']) for (const id of r.ids(type)) {
    const a = r.entity(id)!.attributes;
    const parent = type === 'IFCRELAGGREGATES' ? a[4] : a[6];
    const related = type === 'IFCRELAGGREGATES' ? a[5] : a[4];
    if (refId(parent) === roof && Array.isArray(related)) result.push(...related.map(refId).filter((id): id is number => id !== null));
  }
  return result;
}
const quantities = (s: Session, id: number, name: string) => Object.fromEntries(
  s.view.getQuantitiesForEntity(id).find(set => set.name === name)?.quantities.map(q => [q.name, q.value]) ?? []);

async function session(schema: 'IFC4' | 'IFC2X3' | 'IFC4X3' = 'IFC4') {
  const s = await newStorey(schema);
  s.view.setQuantityExtractor((id, view, occurrence) => {
    const own = extractQuantitiesOnDemand(s.store, id);
    return own.length ? own : deriveAuthoredBaseQuantities(s.store, view, occurrence);
  });
  return s;
}

describe('standard footprint roof plane measurements (#9357)', () => {
  it.each(['IFC4', 'IFC2X3', 'IFC4X3'] as const)('%s: plane slabs carry volume and typed pitch while geometry stays on the roof', async schema => {
    const s = await session(schema);
    const roof = addRoofToStore(s.editor, s.anchor, HIP);
    const children = parts(s, roof.roofId);
    expect(children).toHaveLength(4);
    const reader = new AnchorEntityReader(s.store, s.view);
    expect(reader.entity(roof.roofId)!.attributes[6]).toBe(`#${roof.productShapeId}`);
    let volume = 0;
    for (const id of children) {
      const part = reader.entity(id)!;
      expect(part.type.toUpperCase()).toBe('IFCSLAB');
      expect(part.attributes[8]).toBe('.ROOF.');
      expect(part.attributes[5]).toBeNull();
      expect(part.attributes[6]).toBeNull();
      const q = quantities(s, id, 'Qto_SlabBaseQuantities');
      expect(q.NetVolume).toBeGreaterThan(0);
      expect(q.GrossVolume).toBe(q.NetVolume);
      volume += q.NetVolume;
      expect(s.view.getPropertyValue(id, 'Pset_SlabCommon', 'PitchAngle')).toBeCloseTo(30 * D, 10);
    }
    expect(volume).toBeCloseTo(80 / Math.cos(30 * D) * .25, 7);
    expect(quantities(s, roof.roofId, 'Qto_RoofBaseQuantities')).toMatchObject({ ProjectedArea: 80 });
    const reopened = await parse(exportText(s));
    const reopenedIds = reopened.entityIndex.byType.get('IFCSLAB') ?? [];
    expect(reopenedIds).toHaveLength(4);
    let exportedVolume = 0;
    for (const id of reopenedIds) {
      const q = extractQuantitiesOnDemand(reopened, id).find(set => set.name === 'Qto_SlabBaseQuantities');
      exportedVolume += q?.quantities.find(q => q.name === 'NetVolume')?.value ?? NaN;
      const pitch = extractPropertiesOnDemand(reopened, id).find(set => set.name === 'Pset_SlabCommon')?.properties.find(p => p.name === 'PitchAngle');
      expect(pitch?.value).toBeCloseTo(30 * D, 10);
      expect(pitch?.dataType?.toUpperCase()).toBe('IFCPLANEANGLEMEASURE');
    }
    expect(exportedVolume).toBeCloseTo(volume, 7);
  });

  it('a rebuild replaces owned plane measurements, and Undo restores the original whole roof', async () => {
    const s = await session();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    const before = parts(s, roofId);
    expect(before).toHaveLength(4);
    recordCompoundMutation(s.view, view => editFootprintRoofInStore(s.store, new StoreEditor(s.store, view), roofId,
      { EdgeSlopes: [30 * D, 0, 30 * D, 0], Thickness: .4 }));
    expect(parts(s, roofId)).toHaveLength(2);
    const after = await parse(exportText(s));
    expect(after.entityIndex.byType.get('IFCSLAB')).toHaveLength(2);
    const sum = parts(s, roofId).reduce((v, id) => v + quantities(s, id, 'Qto_SlabBaseQuantities').NetVolume, 0);
    expect(sum).toBeCloseTo(80 / Math.cos(30 * D) * .4, 7);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound roof edit expected'); });
    expect(parts(s, roofId)).toEqual(before);
    expect(parts(s, roofId).reduce((v, id) => v + quantities(s, id, 'Qto_SlabBaseQuantities').NetVolume, 0)).toBeCloseTo(80 / Math.cos(30 * D) * .25, 7);
  });

  it('declared millimetres, square centimetres, cubic millimetres and degrees survive export (#9357)', async () => {
    const initial = await session();
    const add = (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) => `#${initial.editor.addEntity(type, attributes).expressId}`;
    const length = add('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']);
    const area = add('IfcSIUnit', ['*', '.AREAUNIT.', '.CENTI.', '.SQUARE_METRE.']);
    const volume = add('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']);
    const radians = add('IfcSIUnit', ['*', '.PLANEANGLEUNIT.', null, '.RADIAN.']);
    const dimensions = add('IfcDimensionalExponents', [0, 0, 0, 0, 0, 0, 0]);
    const conversion = add('IfcMeasureWithUnit', [{ typed: { type: 'IfcPlaneAngleMeasure', value: D } }, radians]);
    const degrees = add('IfcConversionBasedUnit', [dimensions, '.PLANEANGLEUNIT.', 'degree', conversion]);
    const reader = new AnchorEntityReader(initial.store, initial.view);
    const assignment = [...reader.ids('IFCUNITASSIGNMENT')][0];
    initial.editor.setPositionalAttribute(assignment, 0, [length, area, volume, degrees]);
    const store = await parse(exportText(initial));
    const view = new MutablePropertyView(null, 'units');
    const editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, initial.storeyId, view);
    const roof = addRoofToStore(editor, anchor, HIP);
    const s = { ...initial, store, view, editor, anchor };
    const children = parts(s, roof.roofId);
    const expectedArea = 80 / Math.cos(30 * D);
    expect(children.reduce((sum, id) => sum + quantities(s, id, 'Qto_SlabBaseQuantities').GrossArea, 0)).toBeCloseTo(expectedArea * 1e4, 4);
    expect(children.reduce((sum, id) => sum + quantities(s, id, 'Qto_SlabBaseQuantities').GrossVolume, 0)).toBeCloseTo(expectedArea * .25 * 1e9, 0);
    for (const id of children) expect(view.getPropertyValue(id, 'Pset_SlabCommon', 'PitchAngle')).toBeCloseTo(30, 10);
    const reopened = await parse(exportText(s));
    expect(extractQuantitiesOnDemand(reopened, roof.roofId).find(set => set.name === 'Qto_RoofBaseQuantities')?.quantities.find(q => q.name === 'ProjectedArea')?.value).toBeCloseTo(80 * 1e4, 5);
    for (const id of reopened.entityIndex.byType.get('IFCSLAB') ?? []) {
      const pitch = extractPropertiesOnDemand(reopened, id).find(set => set.name === 'Pset_SlabCommon')?.properties.find(p => p.name === 'PitchAngle');
      expect(pitch?.value).toBeCloseTo(30, 10);
    }
  });

  it.each([false, true])('copy carries independently editable roof-plane measurements (reopened=%s, #9357)', async reopened => {
    let s = await session();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    if (reopened) {
      const store = await parse(exportText(s)), view = new MutablePropertyView(null, 'reopened');
      view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
      view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
      s = { ...s, store, view, editor: new StoreEditor(store, view) };
    }
    const original = parts(s, roofId);
    const [copy] = copyBatchInStore(s.store, s.editor, [roofId], [{ offset: [20, 0, 0] }]);
    const copied = parts(s, copy.copyId);
    expect(copied).toHaveLength(4);
    expect(copied.some(id => original.includes(id))).toBe(false);
    const volume = (ids: number[]) => ids.reduce((sum, id) => sum + quantities(s, id, 'Qto_SlabBaseQuantities').GrossVolume, 0);
    expect(volume(copied)).toBeCloseTo(80 / Math.cos(30 * D) * .25, 7);
    editFootprintRoofInStore(s.store, s.editor, copy.copyId, { EdgeSlopes: [30 * D, 0, 30 * D, 0], Thickness: .4 });
    expect(volume(original)).toBeCloseTo(80 / Math.cos(30 * D) * .25, 7);
    expect(volume(parts(s, copy.copyId))).toBeCloseTo(80 / Math.cos(30 * D) * .4, 7);
    const exported = await parse(exportText(s));
    expect(exported.entityIndex.byType.get('IFCSLAB')).toHaveLength(6);
    expect(exported.entityIndex.byType.get('IFCROOF')).toHaveLength(2);
  });

  it('copy merges saved measurements with unrelated edits and explicit deletions when source extractors are empty (#9357 review)', async () => {
    const original = await session();
    const { roofId } = addRoofToStore(original.editor, original.anchor, HIP);
    const store = await parse(exportText(original)), view = new MutablePropertyView(null, 'no-extractors');
    const editor = new StoreEditor(store, view), source = { ...original, store, view, editor };
    const before = parts(source, roofId);
    const base = extractQuantitiesOnDemand(store, before[0]).find(set => set.name === 'Qto_SlabBaseQuantities')!;
    const gross = base.quantities.find(q => q.name === 'GrossVolume')!.value;
    view.setProperty(roofId, 'Review', 'Note', 'keep saved dimensions', PropertyValueType.Text);
    view.setProperty(before[0], 'Review', 'Note', 'keep saved measures', PropertyValueType.Text);
    view.setQuantity(before[0], 'Qto_SlabBaseQuantities', 'GrossVolume', gross * 2, base.quantities.find(q => q.name === 'GrossVolume')!.type);
    view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
    view.deleteQuantity(before[0], 'Qto_SlabBaseQuantities', 'NetVolume');
    // Preserve a real deletion, then copy without a usable source extractor.
    view.setQuantityExtractor(() => []);
    const [copy] = copyBatchInStore(store, editor, [roofId], [{ offset: [20, 0, 0] }]);
    const copied = parts(source, copy.copyId);
    expect(quantities(source, copied[0], 'Qto_SlabBaseQuantities').GrossArea).toBeGreaterThan(0);
    expect(quantities(source, copied[0], 'Qto_SlabBaseQuantities').GrossVolume).toBeCloseTo(gross * 2, 8);
    expect(quantities(source, copied[0], 'Qto_SlabBaseQuantities').NetVolume).toBeUndefined();
    expect(view.getPropertyValue(copied[0], 'Pset_SlabCommon', 'PitchAngle')).toBeCloseTo(30 * D, 10);
    const exported = await parse(exportText(source));
    const copiedQuantities = extractQuantitiesOnDemand(exported, copied[0]).find(set => set.name === 'Qto_SlabBaseQuantities')!.quantities;
    expect(copiedQuantities.find(q => q.name === 'NetVolume')).toBeUndefined();
    expect(copiedQuantities.find(q => q.name === 'GrossArea')!.value).toBeGreaterThan(0);
    expect(copiedQuantities.find(q => q.name === 'GrossVolume')!.value).toBeCloseTo(gross * 2, 8);
    expect(() => editFootprintRoofInStore(store, editor, copy.copyId, { Thickness: .4 })).not.toThrow();
    const edited = await parse(exportText(source));
    const originalQuantities = extractQuantitiesOnDemand(edited, before[0]).find(set => set.name === 'Qto_SlabBaseQuantities')!.quantities;
    expect(originalQuantities.find(q => q.name === 'GrossVolume')!.value).toBeCloseTo(gross * 2, 8);
    expect(originalQuantities.find(q => q.name === 'NetVolume')).toBeUndefined();
  });
});

const python = process.env.IFCOPENSHELL_PYTHON ?? 'python3';
const hasOracle = spawnSync(python, ['-c', 'import ifcopenshell, ifcopenshell.geom'], { encoding: 'utf8' }).status === 0;
// Three complete independent EXPRESS validations exceed Vitest's five-second default.
it.skipIf(!hasOracle)('IfcOpenShell validates all schema exports and independently meshes plane volumes (#9357; set IFCOPENSHELL_PYTHON)', async () => {
  for (const schema of ['IFC4', 'IFC2X3', 'IFC4X3'] as const) {
    const s = await session(schema);
    addRoofToStore(s.editor, s.anchor, HIP);
    const run = spawnSync(python, [fileURLToPath(new URL('./__test__/roof-plane-oracle.py', import.meta.url))],
      { input: exportText(s), encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).planes).toBe(4);
  }
}, 30_000);
