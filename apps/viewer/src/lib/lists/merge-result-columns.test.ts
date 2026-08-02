/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListResult } from '@ifc-lite/lists';
import { mergeResultColumns } from './merge-result-columns.js';

const base: ColumnDefinition[] = [
  { id: 'qty', source: 'quantity', psetName: 'Qto', propertyName: 'Volume' },
  { id: 'name', source: 'attribute', propertyName: 'Name' },
];

function result(columns: ColumnDefinition[]): ListResult {
  return { columns, rows: [], totalCount: 0, executionTime: 0 };
}

describe('mergeResultColumns (P0 fix, #1573 follow-up)', () => {
  it('first-defined-wins: part A resolved col0.quantityType, part B did not', () => {
    const partA = result([{ ...base[0], quantityType: 2 }, { ...base[1] }]);
    const partB = result([{ ...base[0] }, { ...base[1] }]);

    const merged = mergeResultColumns([partA, partB], base);

    assert.strictEqual(merged[0].quantityType, 2);
    // The base authoring schema is never mutated in place.
    assert.strictEqual(base[0].quantityType, undefined);
  });

  it('falls back to a later part when an earlier part resolved nothing for that column', () => {
    const partA = result([{ ...base[0] }, { ...base[1] }]);
    const partB = result([{ ...base[0], quantityType: 2 }, { ...base[1] }]);

    const merged = mergeResultColumns([partA, partB], base);

    assert.strictEqual(merged[0].quantityType, 2);
  });

  it('carries dataType the same way for property/measure columns', () => {
    const propBase: ColumnDefinition[] = [{ id: 'flow', source: 'property', psetName: 'Pset', propertyName: 'Flow' }];
    const partA = result([{ ...propBase[0], dataType: 'IFCVOLUMETRICFLOWRATEMEASURE' }]);
    const partB = result([{ ...propBase[0] }]);

    const merged = mergeResultColumns([partA, partB], propBase);

    assert.strictEqual(merged[0].dataType, 'IFCVOLUMETRICFLOWRATEMEASURE');
  });

  it('returns the base columns untouched when no part resolved anything', () => {
    const partA = result([{ ...base[0] }, { ...base[1] }]);
    const partB = result([{ ...base[0] }, { ...base[1] }]);

    const merged = mergeResultColumns([partA, partB], base);

    assert.deepStrictEqual(merged, base);
  });

  it('returns the base columns when there are no parts', () => {
    assert.strictEqual(mergeResultColumns([], base), base);
  });
});
