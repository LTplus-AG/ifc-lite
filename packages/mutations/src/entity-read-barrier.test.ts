// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { NewEntityMap } from './new-entity-map.js';
import { observeEntityAttributes, readEntitySnapshot } from './entity-read-barrier.js';
import type { NewEntity } from './types.js';

it('#8452 keeps the number of retained attribute accessor functions independent of authored row count', () => {
  const view = new MutablePropertyView(null, 'accessor-budget');
  const getters = new Set<unknown>(), setters = new Set<unknown>();
  for (let i = 0; i < 1000; i++) {
    const row = view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
    const descriptor = Object.getOwnPropertyDescriptor(row, 'attributes')!;
    getters.add(descriptor.get); setters.add(descriptor.set);
    expect(structuredClone(row).attributes).toEqual([[i, 0, 0]]);
  }
  // An allocation invariant: no getter/setter closure retained per IFC record.
  expect(getters.size).toBe(1); expect(setters.size).toBe(1);
});

it('#8452 notifies every owning map when one row is shared, invalidating borrowed arrays and reference buckets', () => {
  const row: NewEntity = { expressId: 1, type: 'IfcRelAggregates', attributes: [null, null, null, null, '#10', ['#20']] };
  const a = new NewEntityMap([[1, row]]), b = new NewEntityMap([[1, row]]);
  const before = readEntitySnapshot(row);
  row.attributes[4] = '#30';
  expect(readEntitySnapshot(row).attributes[4]).toBe('#30');
  expect(before.attributes[4]).toBe('#10');
  for (const map of [a, b]) {
    expect([...map.referencing(10)]).toEqual([]);
    expect([...map.referencing(30)].map(item => item.expressId)).toEqual([1]);
  }
});

it('#8452 preserves caller accessor descriptors and nonwritable data while observing attributes', () => {
  const row: NewEntity = { expressId: 1, type: 'IfcCartesianPoint', attributes: [] };
  let data: NewEntity['attributes'] = [[1, 2, 3]], reads = 0, writes = 0;
  Object.defineProperty(row, 'attributes', { configurable: true, enumerable: true,
    get() { expect(this).toBe(row); reads++; return data; },
    set(next: NewEntity['attributes']) { expect(this).toBe(row); writes++; data = next; },
  });
  let exposed = 0;
  observeEntityAttributes(row, () => { exposed++; });
  row.attributes = [[4, 5, 6]];
  expect(row.attributes).toEqual([[4, 5, 6]]);
  expect(writes).toBe(1); expect(reads).toBeGreaterThan(0); expect(exposed).toBe(2);
  const fixed: NewEntity = { expressId: 2, type: 'IfcCartesianPoint', attributes: [] };
  Object.defineProperty(fixed, 'attributes', { value: [[7, 8, 9]], writable: false, configurable: true });
  observeEntityAttributes(fixed, () => { exposed++; });
  expect(() => { fixed.attributes = []; }).toThrow(TypeError);
  expect(structuredClone(fixed).attributes).toEqual([[7, 8, 9]]);
});
