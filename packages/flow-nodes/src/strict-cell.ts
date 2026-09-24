/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a spreadsheet cell's text a COMPLETE value of its column's type?
 *
 * `@ifc-lite/mutations`' `parseValue` is lenient by construction: `parseFloat`
 * reads the longest numeric prefix, so `"12,5"` becomes 12 and `"60abc"`
 * becomes 60, and every string other than true/yes/1 becomes `false`. A
 * European CSV (`12,5` in a Real column) therefore wrote 12 into the model
 * with nothing reported. This check runs first at every table→value boundary
 * (the CSV and XLSX readers, and `model.applyTable`), so a value is either
 * exactly what the cell says or reported and left unwritten (#5377 review).
 */

import type { ColumnType } from '@ifc-lite/flow';

const REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
/**
 * IFC LOGICAL's UNKNOWN is deliberately absent: the property model carries a
 * boolean, and writing UNKNOWN as `false` would state a fact the sheet did not.
 */
const BOOLEAN = /^(true|false|yes|no|1|0)$/i;

export function isStrictlyTyped(raw: string, type: ColumnType): boolean {
  const text = raw.trim();
  switch (type) {
    case 'real': return REAL.test(text);
    case 'integer': return INTEGER.test(text);
    case 'boolean':
    case 'logical': return BOOLEAN.test(text);
    default: return true;
  }
}
