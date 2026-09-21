/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { canonicalJson, digest, digestFlowData } from './digest.js';
import { groupRows, pivot, rowKey, validateTable, type Table } from './table.js';
import { group, item, list } from './values.js';

const longFormat: Table = {
  key: 'GlobalId',
  columns: [
    { name: 'GlobalId', type: 'identifier' },
    { name: 'Pset', type: 'label' },
    { name: 'Prop', type: 'label' },
    { name: 'Value', type: 'real', unit: 'm2' },
  ],
  rows: [
    { GlobalId: 'W1', Pset: 'Qto_WallBaseQuantities', Prop: 'NetSideArea', Value: 12.5 },
    { GlobalId: 'W1', Pset: 'Qto_WallBaseQuantities', Prop: 'Length', Value: 5 },
    { GlobalId: 'W2', Pset: 'Qto_WallBaseQuantities', Prop: 'NetSideArea', Value: 8 },
    { GlobalId: '', Pset: 'Qto_WallBaseQuantities', Prop: 'Length', Value: 1 },
  ],
};

describe('validateTable', () => {
  it('accepts a well-formed table', () => {
    expect(validateTable(longFormat)).toEqual([]);
  });

  it('refuses a keyless table, unknown types, duplicate columns and undeclared cells', () => {
    const problems = validateTable({
      key: 'Nope',
      columns: [
        { name: 'A', type: 'real' },
        { name: 'A', type: 'wat' },
      ],
      rows: [{ B: 1 }, { A: {} }],
    });
    expect(problems.map((p) => p.path)).toEqual(['table.columns[1].name', 'table.columns[1].type', 'table.key', 'table.rows[0].B', 'table.rows[1].A']);
  });
});

describe('groupRows / rowKey', () => {
  it('splits rows per key and reports rows with an empty key', () => {
    const { branches, unkeyed } = groupRows(longFormat);
    expect([...branches.keys()]).toEqual(['W1', 'W2']);
    expect(branches.get('W1')).toHaveLength(2);
    expect(unkeyed).toHaveLength(1);
    expect(rowKey(longFormat, longFormat.rows[3])).toBeNull();
  });
});

describe('pivot', () => {
  it('widens long format to one row per entity, keeping the value column type and unit', () => {
    const { table, duplicates } = pivot(longFormat, 'GlobalId', 'Prop', 'Value');
    expect(duplicates).toBe(0);
    expect(table.key).toBe('GlobalId');
    expect(table.columns.map((c) => [c.name, c.type, c.unit])).toEqual([
      ['GlobalId', 'identifier', undefined],
      ['NetSideArea', 'real', 'm2'],
      ['Length', 'real', 'm2'],
    ]);
    expect(table.rows).toEqual([
      { GlobalId: 'W1', NetSideArea: 12.5, Length: 5 },
      { GlobalId: 'W2', NetSideArea: 8 },
    ]);
    expect(validateTable(table)).toEqual([]);
  });

  it('refuses a pivot column that names the key column instead of overwriting the row identity', () => {
    // A long-format row whose `Prop` is literally `GlobalId`: widening it
    // would write its Value into the key column and merge two distinct things.
    const withKeyProp: Table = { ...longFormat, rows: [...longFormat.rows, { GlobalId: 'W1', Pset: 'Pset_X', Prop: 'GlobalId', Value: 'not-an-id' }] };
    const { table, collisions } = pivot(withKeyProp, 'GlobalId', 'Prop', 'Value');
    expect(collisions).toBe(1);
    expect(table.rows.map((r) => r.GlobalId)).toEqual(['W1', 'W2']);
    expect(table.columns.map((c) => c.name)).not.toContain('not-an-id');
    expect(validateTable(table)).toEqual([]);
  });

  it('counts duplicate (row, column) pairs and keeps the last value', () => {
    const dup: Table = { ...longFormat, rows: [longFormat.rows[0], { ...longFormat.rows[0], Value: 99 }] };
    const { table, duplicates } = pivot(dup, 'GlobalId', 'Prop', 'Value');
    expect(duplicates).toBe(1);
    expect(table.rows[0].NetSideArea).toBe(99);
  });
});

describe('digests', () => {
  it('canonical JSON ignores key order and sorts Map entries', () => {
    expect(canonicalJson({ b: 1, a: [new Map([['y', 1], ['x', 2]])] })).toBe(canonicalJson({ a: [new Map([['x', 2], ['y', 1]])], b: 1 }));
    expect(digest({ a: 1 })).toHaveLength(64);
  });

  it('structure is part of a flow value digest', () => {
    expect(digestFlowData(item([1]))).not.toBe(digestFlowData(list([1])));
    expect(digestFlowData(list([1]))).not.toBe(digestFlowData(group([['', [1]]])));
    expect(digestFlowData(group([['b', [1]], ['a', [2]]]))).toBe(digestFlowData(group([['a', [2]], ['b', [1]]])));
  });
});
