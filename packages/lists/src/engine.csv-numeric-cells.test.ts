/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `listResultToCSV`'s numeric exemption, asserted on the BYTES the real writer
 * emits rather than on the helper it calls.
 *
 * This writer is the one remaining hand-rolled escaper in the repo (the sole
 * entry on `scripts/check-csv-escaper-copies.mjs`'s `KNOWN_REMAINING` list),
 * so what it does with a number is not implied by any test of the shared guard.
 * The LANGUAGE itself is pinned once, next to its implementation, in
 * `packages/encoding/src/numeric-literal.test.ts` -- the cases here are only
 * the ones that reach a spreadsheet differently.
 */
import { describe, it, expect } from 'vitest';
import { listResultToCSV } from './engine.js';
import type { ListResult, ColumnDefinition, CellValue } from './types.js';

const ONE_COL: ColumnDefinition[] = [{ id: 'v', source: 'attribute', propertyName: 'V' }];

/** The single data cell of a one-column, one-row export. */
function cell(value: CellValue): string {
  const res: ListResult = {
    columns: ONE_COL,
    rows: [{ entityId: 1, modelId: 'default', values: [value] }],
    totalCount: 1,
    executionTime: 0,
  };
  const lines = listResultToCSV(res).split('\r\n');
  expect(lines).toHaveLength(2); // header + the one row, or the fixture is wrong
  return lines[1];
}

describe('listResultToCSV and the #1772 numeric exemption', () => {
  it('writes a signed number as a number, so the column still sums', () => {
    for (const v of ['-0.35', '+1', '-1.5e-3']) expect(cell(v)).toBe(v);
  });

  it('still guards a trigger, and anything merely glued to a number', () => {
    for (const v of ['=1+1', '@SUM(A1)', '-0.35=cmd', '+1-2']) expect(cell(v)).toBe(`'${v}`);
  });

  it('still guards what a display formatter produced rather than a number', () => {
    // `-1,000` is `toLocaleString()` output for -1000, not one number. It is
    // guarded, then quoted because it carries the delimiter.
    expect(cell('-1,000')).toBe('"\'-1,000"');
    expect(cell('-1 000')).toBe("'-1 000");
  });
});
