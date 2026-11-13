/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { recordCompoundMutation, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { addRoofToStore } from './roof.js';
import { editFootprintRoofInStore } from './roof-footprint.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';
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
});
