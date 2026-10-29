/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { countEffectiveEntityTypes, iterateEffectiveEntities, type EffectiveEntitySource } from './effective-entities.js';
import { EntityTableBuilder } from './entity-table.js';
import { StringTable } from './string-table.js';

const TYPES: Record<number, string> = { 1: 'IfcSpace', 2: 'IfcWall', 3: 'IfcSpace' };
const entities = { expressId: new Uint32Array([1, 2, 3]), getTypeName: (id: number) => TYPES[id] ?? 'Unknown' };
const emptyIndex = { byType: new Map<string, number[]>(), byId: new Map<number, { type: string }>() };

describe('the effective entity set of an IFCX store', () => {
  it('walks the entity table when there is no STEP type index: an IFCX model has spaces', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, schemaVersion: 'IFC5' };
    expect([...iterateEffectiveEntities(ifcx, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 3]);
  });

  it('leaves a store that has a type index to the index, and any other format with no index empty', () => {
    const step: EffectiveEntitySource = {
      entityIndex: { byType: new Map([['IFCSPACE', [1]]]), byId: new Map([[1, { type: 'IFCSPACE' }]]) },
      entities,
      schemaVersion: 'IFC4',
    };
    expect([...iterateEffectiveEntities(step, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1]);
    expect([...iterateEffectiveEntities({ entityIndex: emptyIndex, entities, schemaVersion: 'IFC4' }, null, ['IFCSPACE'])]).toEqual([]);
  });

  it('counts the entity table too: an IFCX model with no pending edits has its spaces and walls', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, schemaVersion: 'IFC5' };
    const counts = countEffectiveEntityTypes(ifcx, null);
    expect(counts.get('IFCSPACE')).toBe(2);
    expect(counts.get('IFCWALL')).toBe(1);
    expect(countEffectiveEntityTypes({ entityIndex: emptyIndex, entities, schemaVersion: 'IFC4' }, null).size).toBe(0);
  });

  it('keeps a zero row for an IFCX class whose every row is deleted', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, schemaVersion: 'IFC5' };
    const overlay = { isDeleted: (id: number) => id === 2, getNewEntities: () => [] };
    const counts = countEffectiveEntityTypes(ifcx, overlay);
    expect(counts.get('IFCWALL')).toBe(0);
    expect(counts.get('IFCSPACE')).toBe(2);
  });

  it('rebuckets the table after a retype: a row moved into a class by setTypeOverride is found by a filtered walk', () => {
    const builder = new EntityTableBuilder(3, new StringTable());
    builder.add(1, 'IFCSPACE', '', 'a', '', '');
    builder.add(2, 'IFCWALL', '', 'b', '', '');
    builder.add(3, 'IFCSPACE', '', 'c', '', '');
    const table = builder.build();
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, schemaVersion: 'IFC5' };
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 3]);
    table.setTypeOverride(2, 'IFCSPACE');
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 2, 3]);
  });

  it('does not cache a table that can be retyped but reports no revision', () => {
    const types: Record<number, string> = { 1: 'IfcSpace', 2: 'IfcWall' };
    const table = {
      expressId: new Uint32Array([1, 2]),
      getTypeName: (id: number) => types[id] ?? 'Unknown',
      setTypeOverride: (id: number, type: string | null) => { if (type) types[id] = type; },
    };
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, schemaVersion: 'IFC5' };
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1]);
    table.setTypeOverride(2, 'IfcSpace');
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 2]);
  });

  it('buckets the table once per model: a second filtered call does not rescan it', () => {
    const rows = 2000;
    const ids = new Uint32Array(rows).map((_, i) => i + 1);
    let reads = 0;
    const table = { expressId: ids, getTypeName: (id: number) => { reads++; return id % 500 === 0 ? 'IfcSpace' : 'IfcWall'; } };
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, schemaVersion: 'IFC5' };
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([500, 1000, 1500, 2000]);
    expect(reads).toBeGreaterThanOrEqual(rows);
    reads = 0;
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])]).toHaveLength(4);
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])]).toHaveLength(4);
    expect(reads).toBeLessThanOrEqual(8 + 8);
  });
});
