/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  countEffectiveEntityTypes,
  iterateEffectiveEntities,
  sourceEntityClasses,
  type EffectiveEntitySource,
} from './effective-entities.js';
import { EntityTableBuilder } from './entity-table.js';
import { StringTable } from './string-table.js';

const TYPES: Record<number, string> = { 1: 'IfcSpace', 2: 'IfcWall', 3: 'IfcSpace' };
const entities = { expressId: new Uint32Array([1, 2, 3]), getTypeName: (id: number) => TYPES[id] ?? 'Unknown' };
const emptyIndex = { byType: new Map<string, number[]>(), byId: new Map<number, { type: string }>() };

describe('the effective entity set of an IFCX store', () => {
  it('walks the entity table when there is no STEP type index: an IFCX model has spaces', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, sourceKind: 'tabular' };
    expect([...iterateEffectiveEntities(ifcx, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 3]);
  });

  it('leaves a store that has a type index to the index, and any other format with no index empty', () => {
    const step: EffectiveEntitySource = {
      entityIndex: { byType: new Map([['IFCSPACE', [1]]]), byId: new Map([[1, { type: 'IFCSPACE' }]]) },
      entities,
      sourceKind: 'step',
    };
    expect([...iterateEffectiveEntities(step, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1]);
    expect([...iterateEffectiveEntities({ entityIndex: emptyIndex, entities }, null, ['IFCSPACE'])]).toEqual([]);
  });

  // #9976: the marker decides, and the deprecated label still decides when no marker is set,
  // so a caller written against the old shape keeps the entity table it used to get.
  it('prefers the marker: a tabular store labelled IFC4 has its rows', () => {
    const tabularIfc4 = { entityIndex: emptyIndex, entities, schemaVersion: 'IFC4', sourceKind: 'tabular' as const };
    expect([...iterateEffectiveEntities(tabularIfc4, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 3]);
    expect(countEffectiveEntityTypes(tabularIfc4, null).get('IFCWALL')).toBe(1);
  });

  it('falls back to the label when no marker is set: an unmarked IFC5 source walks the table', () => {
    const unmarkedIfc5: EffectiveEntitySource = { entityIndex: emptyIndex, entities, schemaVersion: 'IFC5' };
    expect([...iterateEffectiveEntities(unmarkedIfc5, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 3]);
    const counts = countEffectiveEntityTypes(unmarkedIfc5, null);
    expect(counts.get('IFCSPACE')).toBe(2);
    expect(counts.get('IFCWALL')).toBe(1);
  });

  it('lets an explicit marker overrule the label: a step source labelled IFC5 does not walk the table', () => {
    const stepIfc5: EffectiveEntitySource = {
      entityIndex: emptyIndex,
      entities,
      schemaVersion: 'IFC5',
      sourceKind: 'step',
    };
    expect([...iterateEffectiveEntities(stepIfc5, null)]).toEqual([]);
    expect(countEffectiveEntityTypes(stepIfc5, null).size).toBe(0);
  });

  it('counts the entity table too: an IFCX model with no pending edits has its spaces and walls', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, sourceKind: 'tabular' };
    const counts = countEffectiveEntityTypes(ifcx, null);
    expect(counts.get('IFCSPACE')).toBe(2);
    expect(counts.get('IFCWALL')).toBe(1);
    expect(countEffectiveEntityTypes({ entityIndex: emptyIndex, entities }, null).size).toBe(0);
  });

  it('keeps a zero row for an IFCX class whose every row is deleted', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, sourceKind: 'tabular' };
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
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, sourceKind: 'tabular' };
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
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, sourceKind: 'tabular' };
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1]);
    table.setTypeOverride(2, 'IfcSpace');
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([1, 2]);
  });

  // #10018: a caller that narrows the walk to chosen classes has to learn them from somewhere,
  // and the STEP type index cannot tell a tabular store's.
  it('names a tabular source\'s classes from its table, a STEP source\'s from its type index', () => {
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities, sourceKind: 'tabular' };
    expect([...sourceEntityClasses(ifcx)].sort()).toEqual(['IFCSPACE', 'IFCWALL']);

    const step: EffectiveEntitySource = {
      entityIndex: { byType: new Map([['IFCSPACE', [1]]]), byId: new Map([[1, { type: 'IFCSPACE' }]]) },
      entities,
      sourceKind: 'step',
    };
    expect([...sourceEntityClasses(step)]).toEqual(['IFCSPACE']);
    // A format with neither a type index nor the tabular marker has no source classes.
    expect([...sourceEntityClasses({ entityIndex: emptyIndex, entities })]).toEqual([]);
  });

  it('leaves a class-less tabular row out of the class list, as the iterator leaves it out of the walk', () => {
    const withUnknown = {
      expressId: new Uint32Array([1, 4]),
      getTypeName: (id: number) => TYPES[id] ?? 'Unknown',
    };
    const ifcx: EffectiveEntitySource = { entityIndex: emptyIndex, entities: withUnknown, sourceKind: 'tabular' };
    expect([...sourceEntityClasses(ifcx)]).toEqual(['IFCSPACE']);
    expect([...iterateEffectiveEntities(ifcx, null)].map((e) => e.expressId)).toEqual([1]);
  });

  it('buckets the table once per model: a second filtered call does not rescan it', () => {
    const rows = 2000;
    const ids = new Uint32Array(rows).map((_, i) => i + 1);
    let reads = 0;
    const table = { expressId: ids, getTypeName: (id: number) => { reads++; return id % 500 === 0 ? 'IfcSpace' : 'IfcWall'; } };
    const source: EffectiveEntitySource = { entityIndex: emptyIndex, entities: table, sourceKind: 'tabular' };
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])].map((e) => e.expressId)).toEqual([500, 1000, 1500, 2000]);
    expect(reads).toBeGreaterThanOrEqual(rows);
    reads = 0;
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])]).toHaveLength(4);
    expect([...iterateEffectiveEntities(source, null, ['IFCSPACE'])]).toHaveLength(4);
    expect(reads).toBeLessThanOrEqual(8 + 8);
  });
});
